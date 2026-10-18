import { type UserPermissions } from "./config.js";
import { envName, readEnv, type EnvSource } from "./env.js";
import { executeOperation, fetchOperationTools, type McpToolsResponse, type OperationTool } from "./operations.js";
import { isReadMethod, toolPolicy, userAllowsTool } from "./permissions.js";

import type { ToolSource } from "./server.js";

// ─── doctor ────────────────────────────────────────────────────────────────────
//
// `npx @octri/mcp doctor` (or `<your-package> doctor`): every check a person
// otherwise does by trial and error in their AI client, in one run, each with
// what to change when it fails. Exits non-zero when anything failed, so it also
// works in CI.

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export interface DoctorCheck {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface DoctorOptions {
  source: ToolSource;
  env: EnvSource;
  permissions: UserPermissions;
  telemetry: boolean;
  /** Make one real read call. Default true; `--no-call` turns it off. */
  call?: boolean;
  fetch?: typeof fetch;
}

/** The variables an auth scheme reads its credential from. */
function credentialSuffixes(auth: string): string[] {
  if (auth === "bearer" || auth === "oauth2") return ["API_TOKEN"];
  if (auth === "apiKey") return ["API_KEY"];
  if (auth === "basic") return ["API_USERNAME", "API_PASSWORD"];
  return [];
}

/** A read the doctor can make safely: runs on its own, needs no arguments. */
function safeRead(tools: OperationTool[], permissions: UserPermissions): OperationTool | undefined {
  return tools.find(
    (t) =>
      isReadMethod(t.http.method) &&
      toolPolicy(t) === "auto" &&
      userAllowsTool(t, permissions) &&
      ((t.inputSchema as { required?: string[] }).required ?? []).length === 0 &&
      t.http.pathParams.length === 0,
  );
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const { source, env, permissions } = options;
  const checks: DoctorCheck[] = [];
  const add = (status: CheckStatus, name: string, detail: string) => checks.push({ status, name, detail });

  // 1. Where the tools come from.
  let manifest: McpToolsResponse | undefined;
  if (source.kind === "live") {
    if (source.projectId === "") {
      add("fail", "Project", `No project set. Pass --project-id or set ${envName(env, "PROJECT_ID")}.`);
      return checks;
    }
    add("pass", "Project", source.projectId);
    try {
      manifest = await fetchOperationTools(source.apiUrl, source.projectId);
      add("pass", "Octri API", `${source.apiUrl} answered`);
    } catch (err) {
      add(
        "fail",
        "Octri API",
        `Could not load this project's tools from ${source.apiUrl}: ${err instanceof Error ? err.message : String(err)} ` +
          `Check the project id, and ${envName(env, "API_URL")} if you set it.`,
      );
      return checks;
    }
  } else {
    manifest = source.manifest;
    add("pass", "Tools", "built into this package");
  }

  // 2. What an agent will see.
  const visible = manifest.tools.filter((t) => userAllowsTool(t, permissions));
  const asks = visible.filter((t) => toolPolicy(t) === "confirm").length;
  if (visible.length === 0) {
    add(
      "warn",
      "Operation tools",
      manifest.tools.length === 0
        ? "None published. Publish this project's docs and SDK, then run this again."
        : "All are hidden by your own limits (read-only mode or a deny list).",
    );
  } else {
    add(
      "pass",
      "Operation tools",
      `${visible.length} offered${asks > 0 ? `, ${asks} ask the user before each call (needs a client with MCP elicitation, such as Claude Code 2.1.76+)` : ""}`,
    );
  }

  // 3. Where calls go.
  const baseUrl = (readEnv(env, "API_BASE_URL") ?? manifest.baseUrl ?? "").replace(/\/+$/, "");
  if (baseUrl === "") {
    add("fail", "Base URL", `None set. Set ${envName(env, "API_BASE_URL")}.`);
  } else if (!/^https?:\/\//.test(baseUrl)) {
    add("fail", "Base URL", `${baseUrl} is not an http(s) URL.`);
  } else {
    add("pass", "Base URL", `${baseUrl}${readEnv(env, "API_BASE_URL") !== undefined ? " (from your environment)" : ""}`);
  }

  // 4. Credentials for the scheme the API uses.
  const needed = credentialSuffixes(manifest.auth);
  const missing = needed.filter((suffix) => (readEnv(env, suffix) ?? "") === "");
  if (needed.length === 0) {
    add("info", "Credentials", `The API declares no auth scheme (${manifest.auth}).`);
  } else if (missing.length > 0) {
    add("fail", "Credentials", `${manifest.auth} auth: set ${missing.map((s) => envName(env, s)).join(" and ")}.`);
  } else {
    add("pass", "Credentials", `${manifest.auth} auth: ${needed.map((s) => envName(env, s)).join(", ")} set`);
  }

  // 5. One real read, when everything above allows it.
  const blocked = checks.some((c) => c.status === "fail");
  if (options.call === false) {
    add("info", "Test call", "Skipped (--no-call).");
  } else if (permissions.dryRun) {
    add("info", "Test call", "Skipped: dry-run mode sends nothing.");
  } else if (blocked) {
    add("info", "Test call", "Skipped until the failures above are fixed.");
  } else {
    const tool = safeRead(manifest.tools, permissions);
    if (tool === undefined) {
      add("info", "Test call", "No read tool without arguments to try. Ask your agent to call one.");
    } else {
      const result = await executeOperation(tool, manifest, {}, undefined, env, options.fetch);
      const status = /→ (\d{3})/.exec(result.text)?.[1];
      if (result.ok) {
        add("pass", "Test call", `${tool.name}: ${status ?? "ok"}`);
      } else if (status === "401" || status === "403") {
        add("fail", "Test call", `${tool.name}: ${status}. The API refused the credentials. Check ${needed.map((s) => envName(env, s)).join(", ") || "them"}.`);
      } else {
        add("fail", "Test call", `${tool.name}: ${result.text.split("\n")[0] ?? "failed"}`);
      }
    }
  }

  add(
    "info",
    "Usage reporting",
    options.telemetry ? `On. Set ${envName(env, "TELEMETRY")}=0 to turn it off.` : "Off.",
  );
  return checks;
}

const MARK: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };

/** The checks as plain lines, one per check, for a terminal or a CI log. */
export function formatDoctor(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${MARK[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  lines.push("", failed === 0 ? "Ready. Add the server to your client and ask it about your API." : `${failed} ${failed === 1 ? "check" : "checks"} failed.`);
  return `${lines.join("\n")}\n`;
}
