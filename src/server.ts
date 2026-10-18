import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { noUserLimits, SERVER_VERSION, type UserPermissions } from "./config.js";
import { isDocsTool, runDocsTool, TOOLS } from "./docs-tools.js";
import { envName, processEnv, type EnvSource } from "./env.js";
import { executeOperation, fetchOperationTools, type McpToolsResponse } from "./operations.js";
import {
  APPROVAL_NOTE,
  APPROVAL_TIMEOUT_MS,
  needsApproval,
  operationAnnotations,
  sendGate,
  userAllowsTool,
} from "./permissions.js";
import type { CallOutcome, UsageReporter } from "./usage.js";

// ─── MCP server factory ────────────────────────────────────────────────────────

/**
 * Everything an API's operation tools need to be served: the tools, the base
 * URL they call, and the auth scheme they send. The Octri API serves it live
 * (`GET /public/mcp/:projectId/tools`); a package published under a customer's
 * own name carries it as a file.
 */
export type ToolManifest = McpToolsResponse;

/** An Octri project the server reads documentation from and reports usage to. */
export interface OctriProject {
  apiUrl: string;
  projectId: string;
}

/**
 * Where the operation tools come from.
 *
 * `live`   fetched from the Octri API on each listing (cached briefly), so an
 *          owner's publish reaches the agent without a reinstall. Documentation
 *          tools are always served. What `@octri/mcp` does.
 * `static` a manifest fixed at build time, for a server published under the
 *          customer's name. Documentation tools and usage reporting need an
 *          Octri project to talk to, so they are on only when `octri` is set.
 */
export type ToolSource =
  | ({ kind: "live" } & OctriProject)
  | { kind: "static"; manifest: ToolManifest; octri?: OctriProject };

export interface ServerBranding {
  /** The server name a client shows, from the MCP handshake. */
  name: string;
  version: string;
}

export interface CreateServerOptions {
  source: ToolSource;
  /** Default: `@octri/mcp` at this package's version. */
  branding?: ServerBranding;
  /** Where credentials and limits are read. Default: the process env under `OCTRI_`. */
  env?: EnvSource;
  /** The end user's limits. Default: none beyond the owner's. */
  permissions?: UserPermissions;
  /** Counts each tool call for the owner. Default: nothing is reported. */
  reporter?: UsageReporter;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

export function createServer(options: CreateServerOptions): Server {
  const { source, reporter } = options;
  const env = options.env ?? processEnv();
  const permissions = options.permissions ?? noUserLimits();
  const branding = options.branding ?? { name: "@octri/mcp", version: SERVER_VERSION };
  const home: OctriProject | undefined =
    source.kind === "live" ? { apiUrl: source.apiUrl, projectId: source.projectId } : source.octri;
  // Documentation tools read an Octri project; a static build without one has none.
  const docsTools: Tool[] = home !== undefined ? TOOLS : [];
  const servesDocs = (name: string) => home !== undefined && isDocsTool(name);

  const loadOperations = (projectId: string): Promise<ToolManifest> =>
    source.kind === "static"
      ? Promise.resolve(source.manifest)
      : fetchOperationTools(source.apiUrl, projectId);

  const server = new Server(
    { name: branding.name, version: branding.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Docs tools are always available; operation tools are config-derived and
    // fetched live. If the endpoint is unreachable, degrade to docs tools only.
    let opTools: Tool[] = [];
    const projectId = home?.projectId ?? "";
    if (source.kind === "static" || projectId !== "") {
      try {
        const data = await loadOperations(projectId);
        opTools = data.tools
          .filter((t) => userAllowsTool(t, permissions))
          .map((t) => ({
            name: t.name,
            description: needsApproval(t, permissions) ? `${t.description}${APPROVAL_NOTE}` : t.description,
            inputSchema: t.inputSchema,
            annotations: { title: t.name, ...operationAnnotations(t.http.method, t.destructive) },
          }));
      } catch (err) {
        // Degrading to docs-only keeps the server usable, but doing it silently
        // meant a typo'd project id or an unreachable API was indistinguishable
        // from a project that genuinely has no endpoints: the tool list just
        // came back short, with nothing to explain it. Say so once, on stderr,
        // where the client's server log will show it.
        process.stderr.write(
          `Warning: could not load operation tools for project ${projectId}: ${String(err)}\n` +
            `  Serving documentation tools only. Check --project-id / ${envName(env, "PROJECT_ID")} and ${envName(env, "API_URL")}.\n`,
        );
      }
    }
    return { tools: [...docsTools, ...opTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Allow per-call projectId override; fall back to env/flag default. A
    // static manifest belongs to one project, so there it only steers the
    // documentation tools.
    const projectId =
      typeof a["projectId"] === "string" && a["projectId"] !== ""
        ? a["projectId"]
        : (home?.projectId ?? "");

    if (source.kind === "live" && projectId === "") {
      return textResult(
        `Error: projectId is required. Set the ${envName(env, "PROJECT_ID")} environment variable or pass --project-id on the command line.`,
        true,
      );
    }

    // Set once `name` is known to be one of this server's tools, so an unknown
    // name an agent made up is never counted as a call to anything.
    let counted: string | undefined;
    const startedAt = Date.now();
    const report = (outcome: CallOutcome) => {
      if (counted === undefined || reporter === undefined || projectId === "") return;
      const client = server.getClientVersion()?.name;
      reporter.record(projectId, {
        tool: counted,
        outcome,
        durationMs: Date.now() - startedAt,
        ...(client !== undefined && client !== "" ? { client: client.slice(0, 64) } : {}),
        at: new Date(startedAt).toISOString(),
      });
    };

    try {
      // Operation tools (executable, config-derived) aren't in the static docs
      // set, so resolve + perform the real API call for them.
      if (!servesDocs(name)) {
        const data = await loadOperations(projectId);
        const tool = data.tools.find((t) => t.name === name);
        if (tool !== undefined && !userAllowsTool(tool, permissions)) {
          // Not listed for this user, so to the agent it does not exist. Saying
          // why helps the person reading the transcript, not the model.
          return textResult(
            `Not available: ${name} is turned off for this server (read-only mode, a deny list, or the project's own settings).`,
            true,
          );
        }
        if (tool !== undefined) {
          counted = tool.name;
          const gate = sendGate(
            tool,
            permissions,
            {
              capabilities: () => server.getClientCapabilities(),
              ask: async (message) => {
                const answer = await server.elicitInput(
                  { mode: "form", message, requestedSchema: { type: "object", properties: {} } },
                  { timeout: APPROVAL_TIMEOUT_MS },
                );
                return answer.action;
              },
            },
            env.prefix,
          );
          const result = await executeOperation(tool, data, a, gate, env);
          report(result.held ?? (result.ok ? "ok" : "error"));
          return textResult(result.text, !result.ok);
        }
        // Not a known operation tool → fall through to the unknown-tool default.
        return textResult(`Unknown tool: ${name}`, true);
      }

      counted = name;
      // `servesDocs` guarantees an Octri project to read from.
      const text = await runDocsTool(name, a, home?.apiUrl ?? "", projectId);
      report("ok");
      return textResult(text);
    } catch (err) {
      report("error");
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Error: ${message}`, true);
    }
  });

  return server;
}
