import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

import { runChain, type ChainGate, type ChainStep, type ChainTool } from "./chains.js";
import {
  codeModeTools,
  DEFAULT_RUN_LIMITS,
  DESCRIBE_SDK,
  describeSdkText,
  envelopeFor,
  isCodeTool,
  offeredLanguages,
  pythonProgram,
  RUN_CODE,
  runResultText,
  safeReviver,
  sdkMethods,
  typeScriptProgram,
  type CallRecord,
  type RunLimits,
} from "./code-mode.js";
import { isCodeLanguage, type CodeLanguage } from "./code-sdk.js";
import { DEFAULT_SANDBOX_LIMITS, type CodeSandbox, type SandboxLimits } from "./code-sandbox.js";
import {
  changeMeta,
  changeNotes,
  foldChanges,
  oldNameAnswer,
  releasesSince,
  WHAT_CHANGED,
  whatChangedResult,
  whatChangedTool,
  type ChangesSince,
  type FoldedChange,
  type ToolChanges,
} from "./changes.js";
import { noUserLimits, SERVER_VERSION, type UserPermissions } from "./config.js";
import { isDocsTool, runDocsTool, TOOLS } from "./docs-tools.js";
import { narrowToGroup, servedGroup, UnknownGroupError } from "./groups.js";
import { logLine } from "./log.js";
import { envName, processEnv, readEnv, type EnvSource } from "./env.js";
import {
  effectiveBaseUrl,
  executeOperation,
  fetchOperationTools,
  type McpToolsResponse,
  type OperationResult,
  type OperationTool,
  type SendGate,
} from "./operations.js";
import {
  APPROVAL_NOTE,
  APPROVAL_TIMEOUT_MS,
  chainGate,
  chainKey,
  chainNeedsApproval,
  needsApproval,
  operationAnnotations,
  sendGate,
  userAllowsChain,
  userAllowsTool,
} from "./permissions.js";
import {
  PRACTICE_CONTROL,
  PRACTICE_HEADER,
  PRACTICE_INSTRUCTIONS,
  PRACTICE_META_KEY,
  PRACTICE_OFF_TEXT,
  PRACTICE_TOOL_PREFIX,
  practiceAsked,
  practiceControlTool,
  practiceFetch,
  practiceManifest,
  PracticeSession,
  runPracticeControl,
} from "./practice.js";
import { getPrompt, listPrompts, type PromptTemplate } from "./prompts.js";
import { buildErrorGuide, credentialVarNames, type CredentialOrigin, type ErrorGuide } from "./error-guide.js";
import { credentialSecrets, redactSecrets } from "./redact.js";
import {
  auditArguments,
  isWriteCall,
  limitResult,
  processCallLimiter,
  SessionLimits,
  type AuditEvent,
  type CallLimiter,
  type LimitHit,
} from "./limits.js";
import { findResource, listResources, readResource } from "./resources.js";
import {
  chainStatus,
  httpStatusSource,
  isKnownOutage,
  operationStatus,
  outageResult,
  statusMeta,
  statusNote,
  type OutageStatus,
  type StatusSource,
  type ToolStatus,
} from "./status.js";
import {
  buildToolIndex,
  CALL_TOOL,
  DESCRIBE_MAX,
  DESCRIBE_TOOL,
  isMetaTool,
  LIST_TOOL_GROUPS,
  resolveToolMode,
  resultLine,
  SEARCH_TOOLS,
  searchModeTools,
  searchTools,
  toolGroups,
  type ToolIndex,
  type ToolMode,
} from "./tool-search.js";
import type { CallEvent, CallOutcome, UsageReporter } from "./usage.js";

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
  /**
   * Serve the documentation tools. Default true. A project whose docs sit
   * behind a sign-in gate turns them off: the server carries no reader token,
   * so every docs call would fail, while usage reporting still works.
   */
  docs?: boolean;
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
  /**
   * Sends operation calls. Default: global fetch. A host that runs the server
   * on its own infrastructure passes one that refuses private addresses.
   */
  fetch?: typeof fetch;
  /**
   * Serve only this tool group of the project (`--group`, or a group's hosted
   * URL). Applied wherever the tools are loaded, so listing and calling see the
   * same slice. A group the project does not have serves nothing.
   */
  group?: string;
  /**
   * How the operation tools are listed, set by whoever runs the server. Wins
   * over the owner's published mode. Default: the owner's mode, else `auto`.
   */
  toolMode?: ToolMode;
  /**
   * Prompts not served, by name (`--skip-prompts`, or `?skip_prompts=` on a
   * hosted URL): a Claude Code plugin passes the ones it ships as commands, so
   * its `/` menu lists each once. Default: every prompt.
   */
  skipPrompts?: ReadonlySet<string>;
  /**
   * Checks the answers to approval prompts against their schema. Default: the
   * MCP SDK's own (Ajv), which compiles schemas into code at runtime. A
   * Cloudflare Worker forbids that, so the Worker host passes the SDK's
   * Workers validator instead.
   */
  jsonSchemaValidator?: jsonSchemaValidator;
  /**
   * Where endpoint health is read, so tools say when their endpoint is down.
   * Default: the Octri project's public status endpoint, when there is a
   * project and `<PREFIX>_OUTAGE_STATUS` is not `0`. The hosted server reads it
   * in-process. False turns it off.
   */
  status?: StatusSource | false;
  /**
   * Where the API credential comes from, which decides who a refused one's
   * guide tells the agent to ask. Default: `env`, or `none` when no credential
   * variable is set. The hosted server passes `stored`, `signin` or `client`.
   */
  credentialOrigin?: CredentialOrigin;
  /**
   * Where this agent's view of the tools starts, for the "changed since you
   * last connected" notes: the release it last saw (null: nothing known, so
   * the last few days), and what to call once it has been shown the current
   * one. The hosted server keeps it per agent; a server on the user's machine
   * in a file (see change-state.ts). False turns the notes and `what_changed`
   * off. `<PREFIX>_CHANGES_SINCE` pins the start, `<PREFIX>_CHANGE_NOTICES=0`
   * turns them off.
   */
  changes?: { since?: ChangesSince; onSeen?: (release: number) => void } | false;
  /**
   * Practice mode: every operation call is answered with a fake response built
   * from the manifest's `practice` data and this session's own records, and
   * nothing is sent anywhere. Approval prompts, outage notes and change notes
   * are off, every result is marked, and usage counts it as `practice`.
   * Default: `<PREFIX>_PRACTICE`. `callLimit` caps the calls one session makes.
   */
  practice?: boolean | { seed?: string; callLimit?: number };
  /**
   * Runs code mode scripts. Code mode is offered only when the owner published
   * it and this sandbox can run one of its languages; otherwise a request for
   * it falls back to search. A Node host passes `nodeCodeSandbox()`, a Worker
   * `inProcessCodeSandbox(...)`. Default: none.
   */
  codeSandbox?: CodeSandbox | Promise<CodeSandbox | undefined>;
  /** Code mode's sandbox limits. Default: DEFAULT_SANDBOX_LIMITS. */
  codeLimits?: SandboxLimits;
  /**
   * Counts calls per tool per minute for the owner's safety limits (the
   * manifest's `limits`). Default: one counter per process, shared by its
   * sessions. The hosted server passes one every instance shares.
   */
  limiter?: CallLimiter;
}

/** The env a practice session reads: no base URL override and no credential, so none can reach a request. */
function practiceEnv(env: EnvSource): EnvSource {
  const dropped = new Set(
    ["API_BASE_URL", "API_TOKEN", "API_KEY", "API_USERNAME", "API_PASSWORD"].map((suffix) => envName(env, suffix)),
  );
  return { prefix: env.prefix, vars: Object.fromEntries(Object.entries(env.vars).filter(([k]) => !dropped.has(k))) };
}

/** A tool result with the practice header on its text and the practice mark in its meta. */
function markPractice<T extends { content?: unknown; _meta?: Record<string, unknown> }>(result: T): T {
  const content = Array.isArray(result.content) ? [...(result.content as { type: string; text?: string }[])] : [];
  const first = content[0];
  if (first !== undefined && first.type === "text") content[0] = { ...first, text: `${PRACTICE_HEADER}\n\n${first.text ?? ""}` };
  else content.unshift({ type: "text", text: PRACTICE_HEADER });
  return { ...result, content, _meta: { ...result._meta, [PRACTICE_META_KEY]: true } };
}

/**
 * Whether any API credential variable is set. Not keychain.ts's own check:
 * importing that module would pull the system keychain into the Worker build.
 */
function credentialSet(env: EnvSource): boolean {
  return ["API_TOKEN", "API_KEY", "API_USERNAME", "API_PASSWORD"].some((suffix) => (readEnv(env, suffix)?.trim() ?? "") !== "");
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

/**
 * The tool an agent's call names: one of the API's operation tools, or one of
 * the owner's chained tools. Operation tools win a name clash (publishing
 * refuses one, so it can only come from an old manifest).
 *
 * Large-API search mode resolves `call_tool` names through this too, so a
 * chained tool keeps its permissions, approval, dry run and usage there. Chains
 * stay listed by name in that mode rather than in the operation search index.
 */
export type ServedTool =
  | { kind: "operation"; tool: ToolManifest["tools"][number] }
  | { kind: "chain"; chain: ChainTool };

export function findServedTool(manifest: ToolManifest, name: string): ServedTool | undefined {
  const tool = manifest.tools.find((t) => t.name === name);
  if (tool !== undefined) return { kind: "operation", tool };
  const chain = manifest.chains?.find((c) => c.name === name);
  return chain !== undefined ? { kind: "chain", chain } : undefined;
}

/** A chained tool's MCP hints, read off its steps. */
function chainAnnotations(chain: ChainTool): Tool["annotations"] {
  return {
    title: chain.name,
    readOnlyHint: chain.readOnly,
    destructiveHint: chain.readOnly ? false : chain.destructive,
    // Several requests in a row are never safe to repeat blindly.
    idempotentHint: chain.readOnly,
    openWorldHint: true,
  };
}

// ─── Search mode answers ───────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const stringArg = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const numberArg = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The arguments `call_tool` forwards. Some models send the object as a JSON
 * string; that is read the same way rather than failing a call over quoting.
 */
function callArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    if (raw.trim() === "") return {};
    try {
      return callArguments(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** A name nobody serves, with the nearest ones that are. */
function unknownOperation(index: ToolIndex, name: string): string {
  const near = searchTools(index, name, { limit: 3 }).matches.map((t) => t.name);
  return (
    `Unknown operation: ${name}.` +
    (near.length > 0 ? ` Closest: ${near.join(", ")}.` : "") +
    ` Find operations with ${SEARCH_TOOLS}.`
  );
}

function searchText(
  index: ToolIndex,
  visible: readonly OperationTool[],
  args: Record<string, unknown>,
  permissions: UserPermissions,
  healthOf: (tool: OperationTool) => ToolStatus | undefined = () => undefined,
  changedOf: (tool: OperationTool) => "new" | "changed" | "breaking" | undefined = () => undefined,
): string {
  const query = stringArg(args["query"]);
  const group = stringArg(args["group"]);
  const grouped = toolGroups(visible).length >= 2;
  if (query === "" && group === "") {
    return (
      `Pass a query: what the operation does, in a few words.` +
      (grouped ? ` Or pass a group to browse it; ${LIST_TOOL_GROUPS} lists them.` : "")
    );
  }
  const offset = Math.max(Math.trunc(numberArg(args["offset"]) ?? 0), 0);
  const { matches, total } = searchTools(index, query, {
    group,
    limit: numberArg(args["limit"]),
    offset,
  });
  const scope = `${query !== "" ? ` match "${query}"` : ""}${group !== "" ? ` in ${group}` : ""}`;
  if (total === 0) {
    return (
      `No operations${scope}. Try other words` +
      (grouped ? `, or browse a group from ${LIST_TOOL_GROUPS}` : "") +
      "."
    );
  }
  const shown =
    matches.length === 0
      ? ` (none past offset ${offset})`
      : matches.length < total
        ? ` (showing ${offset + 1} to ${offset + matches.length})`
        : "";
  const more = offset + matches.length < total ? ` Pass offset ${offset + matches.length} for more.` : "";
  return [
    `${plural(total, "operation", "operations")} of ${visible.length.toLocaleString("en-US")}${query !== "" ? scope : ` in ${group}`}${shown}:`,
    "",
    ...matches.map((t) => resultLine(t, needsApproval(t, permissions), healthOf(t)?.entry.state, changedOf(t))),
    "",
    `Next: ${DESCRIBE_TOOL} with the names you need, then ${CALL_TOOL}.${more}`,
  ].join("\n");
}

function describeText(
  index: ToolIndex,
  args: Record<string, unknown>,
  permissions: UserPermissions,
  listed: (tool: OperationTool) => Tool,
): string {
  const raw = Array.isArray(args["names"]) ? args["names"] : [args["names"] ?? args["name"]];
  const names = [...new Set(raw.map(stringArg).filter((n) => n !== ""))];
  if (names.length === 0) return `Pass names: the operation names ${SEARCH_TOOLS} returned.`;
  const sections = names.slice(0, DESCRIBE_MAX).map((name) => {
    const tool = index.byName.get(name);
    if (tool === undefined) return `## ${name}\n\n${unknownOperation(index, name)}`;
    const entry = listed(tool);
    const traits = [
      `${tool.http.method} ${tool.http.path}`,
      ...(tool.group !== undefined && tool.group !== "" ? [`group: ${tool.group}`] : []),
      needsApproval(tool, permissions) ? "asks the user to approve each call" : "runs without asking",
      entry.annotations?.readOnlyHint === true
        ? "read-only"
        : entry.annotations?.destructiveHint === true
          ? "can change or delete data"
          : "adds data",
    ];
    return `## ${tool.name}\n${traits.join(" · ")}\n\n${entry.description ?? ""}\n\nInput schema: ${JSON.stringify(tool.inputSchema)}`;
  });
  const dropped = names.length > DESCRIBE_MAX ? `\n\nOnly the first ${DESCRIBE_MAX} names are described; ask again for the rest.` : "";
  return `${sections.join("\n\n")}${dropped}\n\nRun one with ${CALL_TOOL}.`;
}

function groupsText(visible: readonly OperationTool[]): string {
  const groups = toolGroups(visible);
  if (groups.length === 0) return `This API's operations are not grouped. Find them with ${SEARCH_TOOLS}.`;
  return [
    `${plural(visible.length, "operation", "operations")} in ${plural(groups.length, "group", "groups")}:`,
    "",
    ...groups.map(
      (g) =>
        `${g.name} (${g.tools.length}): ${g.tools.slice(0, 3).map((t) => t.name).join(", ")}${g.tools.length > 3 ? ", …" : ""}`,
    ),
    "",
    `Browse one with ${SEARCH_TOOLS} and its group.`,
  ].join("\n");
}

type ChangeNote = { note: string; change: FoldedChange };

export function createServer(options: CreateServerOptions): Server {
  const { source, reporter } = options;
  const hostEnv = options.env ?? processEnv();
  const practiceOn =
    options.practice !== undefined ? options.practice !== false : practiceAsked(readEnv(hostEnv, "PRACTICE"));
  const practiceOptions = typeof options.practice === "object" ? options.practice : {};
  const practice = practiceOn
    ? new PracticeSession({
        ...(practiceOptions.seed !== undefined ? { seed: practiceOptions.seed } : {}),
        ...(practiceOptions.callLimit !== undefined ? { callLimit: practiceOptions.callLimit } : {}),
      })
    : undefined;
  // In practice no credential or base URL override can reach a request.
  const env = practiceOn ? practiceEnv(hostEnv) : hostEnv;
  const basePermissions = options.permissions ?? noUserLimits();
  // Practice answers every call itself, so a dry run has nothing left to hold back.
  const permissions = practiceOn ? { ...basePermissions, dryRun: false } : basePermissions;
  const baseBranding = options.branding ?? { name: "@octri/mcp", version: SERVER_VERSION };
  const branding = practiceOn ? { ...baseBranding, name: `${baseBranding.name} (practice)` } : baseBranding;
  const home: OctriProject | undefined =
    source.kind === "live" ? { apiUrl: source.apiUrl, projectId: source.projectId } : source.octri;
  // Documentation tools read an Octri project; a static build without one has none.
  const withDocs = home !== undefined && home.docs !== false;
  const docsTools: Tool[] = withDocs ? TOOLS : [];
  const servesDocs = (name: string) => withDocs && isDocsTool(name);

  // Code mode's sandbox, which a Node host loads in the background.
  let codeSandbox: CodeSandbox | undefined;
  const sandboxReady: Promise<void> = Promise.resolve(options.codeSandbox)
    .then((found) => {
      codeSandbox = found;
    })
    .catch(() => undefined);
  const codeLimits = options.codeLimits ?? DEFAULT_SANDBOX_LIMITS;
  const runLimits: RunLimits = DEFAULT_RUN_LIMITS;
  // The owner's safety limits: writes are counted for this session, calls per
  // minute through the limiter.
  const sessionLimits = new SessionLimits(options.limiter ?? processCallLimiter());
  /** An opaque id that groups this session's audit entries. */
  const auditSession = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24);

  const { group } = options;
  // Endpoint health, read live: a hosted session's manifest is frozen when it
  // opens, but an outage starts and ends whenever it likes.
  const statusSource: StatusSource | undefined =
    options.status === false || practiceOn
      ? undefined
      : (options.status ??
        (home !== undefined && home.projectId !== "" && readEnv(env, "OUTAGE_STATUS")?.trim() !== "0"
          ? httpStatusSource(home.apiUrl, home.projectId)
          : undefined));
  /** The project's endpoint health, or null when nothing is known. Never throws. */
  const readStatus = async (data: ToolManifest): Promise<OutageStatus | null> =>
    statusSource === undefined || data.outageWarnings === false ? null : statusSource.read().catch(() => null);
  // One practice copy per manifest, so the per-manifest caches below keep working.
  const practiceCopies = new WeakMap<ToolManifest, ToolManifest>();
  const loadOperations = async (projectId: string): Promise<ToolManifest> => {
    const data =
      source.kind === "static"
        ? source.manifest
        : await fetchOperationTools(source.apiUrl, projectId, practiceOn ? { practice: true } : {});
    const narrowed = group !== undefined ? narrowToGroup(data, group) : data;
    if (!practiceOn) return narrowed;
    let copy = practiceCopies.get(narrowed);
    if (copy === undefined) {
      copy = practiceManifest(narrowed);
      practiceCopies.set(narrowed, copy);
    }
    return copy;
  };
  const practiceFetches = new WeakMap<ToolManifest, typeof fetch>();
  /** What sends an operation call: practice answers it here; otherwise the host's fetch, or the global one. */
  const fetchFor = (data: ToolManifest): typeof fetch | undefined => {
    if (practice === undefined) return options.fetch;
    let found = practiceFetches.get(data);
    if (found === undefined) {
      found = practiceFetch(data, practice);
      practiceFetches.set(data, found);
    }
    return found;
  };
  // A group can leave the documentation tools out; reading that needs the
  // manifest, which a live server fetches (and caches) like any listing.
  const docsServed = async (projectId: string): Promise<boolean> =>
    group === undefined || servedGroup(await loadOperations(projectId), group)?.docs !== false;

  const server = new Server(
    { name: branding.name, version: branding.version },
    {
      // listChanged: a tool's description changes when its endpoint goes down or recovers.
      capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
      ...(practiceOn ? { instructions: PRACTICE_INSTRUCTIONS } : {}),
      ...(options.jsonSchemaValidator !== undefined ? { jsonSchemaValidator: options.jsonSchemaValidator } : {}),
    },
  );

  /** One usage event, when there is somewhere to send it. */
  const record = (projectId: string, event: Omit<CallEvent, "at" | "client" | "group"> & { at?: string }) => {
    if (reporter === undefined || projectId === "") return;
    const client = server.getClientVersion()?.name;
    reporter.record(projectId, {
      ...event,
      ...(group !== undefined ? { group } : {}),
      ...(client !== undefined && client !== "" ? { client: client.slice(0, 64) } : {}),
      at: event.at ?? new Date().toISOString(),
    });
  };
  /** One audit entry, when there is somewhere to send it. The caller checks the owner keeps a log. */
  const audit = (
    projectId: string,
    event: Omit<AuditEvent, "at" | "client" | "group" | "session"> & { at?: string },
  ) => {
    if (reporter === undefined || projectId === "") return;
    const client = server.getClientVersion()?.name;
    reporter.audit(projectId, {
      ...event,
      ...(group !== undefined ? { group } : {}),
      ...(client !== undefined && client !== "" ? { client: client.slice(0, 64) } : {}),
      session: auditSession,
      at: event.at ?? new Date().toISOString(),
    });
  };
  /** How a write got past approval: asked now, pre-approved by an allow list, or never asked. */
  const approvalOf = (asks: boolean, wouldAsk: boolean): AuditEvent["approval"] =>
    asks ? "prompt" : wouldAsk ? "allow_list" : "auto";
  /** The same permissions without an allow list, to tell a pre-approved call from one that never asks. */
  const unallowed: UserPermissions = { ...permissions, allow: new Set() };
  /** The limits a call is held to. None in practice or a dry run: nothing is sent. */
  const limitsOf = (data: ToolManifest) => (practiceOn || permissions.dryRun ? undefined : data.limits);
  // Read per call: a host may swap the credential mid-session (a refreshed token).
  const redact = (text: string) => redactSecrets(text, credentialSecrets(env));
  // Tied to the tool call that needs the approval, so the prompt goes out on
  // that call's own response stream. Without it, Streamable HTTP sends it on
  // the session's standalone GET stream, and a client that never opens one
  // waits on the prompt until it times out.
  const ask = async (message: string, relatedRequestId?: RequestId) => {
    const answer = await server.elicitInput(
      { mode: "form", message: redact(message), requestedSchema: { type: "object", properties: {} } },
      { timeout: APPROVAL_TIMEOUT_MS, ...(relatedRequestId !== undefined ? { relatedRequestId } : {}) },
    );
    return answer.action;
  };

  // The operations this user may see, and their search index, per manifest.
  // A live manifest is replaced when its cache entry expires, which drops these.
  const visibleCache = new WeakMap<ToolManifest, { tools: OperationTool[]; index?: ToolIndex }>();
  const visibleOf = (data: ToolManifest) => {
    let entry = visibleCache.get(data);
    if (entry === undefined) {
      entry = { tools: data.tools.filter((t) => userAllowsTool(t, permissions)) };
      visibleCache.set(data, entry);
    }
    return entry;
  };
  const indexOf = (data: ToolManifest): ToolIndex => {
    const entry = visibleOf(data);
    entry.index ??= buildToolIndex(entry.tools);
    return entry.index;
  };
  /** The script languages this server offers: what the owner published, that the sandbox runs. */
  const codeLanguagesOf = (data: ToolManifest): CodeLanguage[] =>
    offeredLanguages(data.codeMode, codeSandbox?.languages ?? []);
  const modeOf = (data: ToolManifest) =>
    resolveToolMode(
      options.toolMode,
      data.toolMode,
      visibleOf(data).tools.length,
      codeLanguagesOf(data).length > 0,
      data.searchThreshold,
    );
  let codeFallbackLogged = false;
  /** Asked for code mode and not getting it: say why once, where the client's server log shows it. */
  const noticeCodeFallback = (data: ToolManifest) => {
    if (codeFallbackLogged || (options.toolMode ?? data.toolMode) !== "code" || modeOf(data) === "code") return;
    codeFallbackLogged = true;
    logLine(
      data.codeMode === undefined
        ? "Code mode is not published for this project, so the tools are listed in search mode.\n"
        : "This server cannot run scripts here (no sandbox for the published languages), so the tools are listed in search mode.\n",
    );
  };

  /** A failing endpoint's note goes first, so an agent skimming the list sees it. */
  const withHealth = (tool: Tool, health: ToolStatus | undefined): Tool =>
    health === undefined
      ? tool
      : {
          ...tool,
          description: `${statusNote(health)}\n\n${tool.description ?? ""}`,
          _meta: { ...tool._meta, ...statusMeta(health) },
        };

  /** A tool that changed since the agent last connected says so, under any outage note. */
  const withChange = (tool: Tool, change: ChangeNote | undefined): Tool =>
    change === undefined
      ? tool
      : {
          ...tool,
          description: `${change.note}\n\n${tool.description ?? ""}`,
          _meta: { ...tool._meta, ...changeMeta(change.change) },
        };

  /** The tool as listed in `all` mode, and as described in `search` mode. */
  /** In practice mode a description says so first, and no prompt is promised: none is asked. */
  const describe = (description: string, asks: boolean) =>
    practiceOn ? `${PRACTICE_TOOL_PREFIX}${description}` : asks ? `${description}${APPROVAL_NOTE}` : description;
  const listed = (t: OperationTool, health?: ToolStatus, change?: ChangeNote): Tool =>
    withHealth(
      withChange(
        {
          name: t.name,
          description: describe(t.description, needsApproval(t, permissions)),
          inputSchema: t.inputSchema,
          annotations: { title: t.name, ...operationAnnotations(t.http.method, t.destructive) },
        },
        change,
      ),
      health,
    );

  /** A chained tool as listed: by its own name in either mode, since an owner writes few. */
  const listedChain = (chain: ChainTool, health?: ToolStatus, change?: ChangeNote): Tool =>
    withHealth(
      withChange(
        {
          name: chain.name,
          description: describe(chain.description, chainNeedsApproval(chain, permissions)),
          inputSchema: chain.inputSchema,
          annotations: chainAnnotations(chain),
        },
        change,
      ),
      health,
    );

  // What changed since the agent last connected. The start is fixed for the
  // session: notes stay on for as long as it lasts, and the next session
  // starts from the release this one was shown.
  const pinnedSince = readEnv(env, "CHANGES_SINCE")?.trim();
  // A practice session is anonymous and its tools are not the agent's real view: no notes.
  const noticesOn = !practiceOn && options.changes !== false && readEnv(env, "CHANGE_NOTICES")?.trim() !== "0";
  const sessionSince: ChangesSince =
    pinnedSince !== undefined && /^\d+$/.test(pinnedSince)
      ? Number(pinnedSince)
      : options.changes !== false && options.changes?.since !== undefined
        ? options.changes.since
        : null;
  const changesOf = (data: ToolManifest): ToolChanges | undefined => (noticesOn ? data.changes : undefined);
  /** A name the manifest serves that this user may not see: never reported to them. */
  const hiddenFrom = (data: ToolManifest) => {
    const visible = new Set(visibleOf(data).tools.map((t) => t.name));
    for (const chain of data.chains ?? []) if (userAllowsChain(chain, permissions)) visible.add(chain.name);
    const served = new Set([...data.tools.map((t) => t.name), ...(data.chains ?? []).map((c) => c.name)]);
    return (name: string) => served.has(name) && !visible.has(name);
  };
  const foldedCache = new WeakMap<ToolManifest, FoldedChange[]>();
  const foldedOf = (data: ToolManifest): FoldedChange[] => {
    const changes = changesOf(data);
    if (changes === undefined) return [];
    let folded = foldedCache.get(data);
    if (folded === undefined) {
      const hidden = hiddenFrom(data);
      folded = foldChanges(releasesSince(changes, sessionSince)).filter((c) => !hidden(c.name));
      foldedCache.set(data, folded);
    }
    return folded;
  };
  /**
   * `what_changed` is served once the history holds a change (a server with
   * only its first release has nothing to say), and answers to its name
   * unless a served tool already has it.
   */
  const servesWhatChanged = (data: ToolManifest) => {
    const changes = changesOf(data);
    return (
      changes !== undefined &&
      changes.history.some((release) => release.tools.length > 0) &&
      findServedTool(data, WHAT_CHANGED) === undefined
    );
  };
  let seenReported = false;
  /** Tells whoever keeps the agent's place that it has now been shown this release. */
  const markSeen = (data: ToolManifest) => {
    const changes = changesOf(data);
    const onSeen = options.changes !== false ? options.changes?.onSeen : undefined;
    if (changes === undefined || onSeen === undefined || seenReported) return;
    seenReported = true;
    try {
      onSeen(changes.release);
    } catch {
      // Keeping the place is best effort: the agent was still told.
    }
  };
  /** The release the last listing showed. A live manifest moving past it means: list again. */
  let listedRelease: number | undefined;
  const noticeRelease = (data: ToolManifest) => {
    const release = changesOf(data)?.release;
    if (listedRelease === undefined || release === undefined || release === listedRelease) return;
    listedRelease = release;
    server.sendToolListChanged().catch(() => undefined);
  };

  /**
   * What the last listing said about endpoint health. When a call reads a
   * different picture, the client is told to list again, so a tool's warning
   * appears when an outage starts and goes when it ends. Search mode lists only
   * the meta tools, whose descriptions never carry health.
   */
  let listedHealth: string | undefined;
  const healthPrint = (data: ToolManifest, status: OutageStatus | null): string => {
    if (status === null || modeOf(data) !== "all") return "";
    const base = effectiveBaseUrl(data, env);
    const parts: string[] = [];
    for (const t of visibleOf(data).tools) {
      const h = operationStatus(status, t, base);
      if (h !== undefined) parts.push(`${t.name}:${h.entry.state}`);
    }
    for (const c of data.chains ?? []) {
      const h = chainStatus(status, c, base);
      if (h !== undefined) parts.push(`${c.name}:${h.entry.state}`);
    }
    return parts.join(",");
  };
  const noticeHealth = (data: ToolManifest, status: OutageStatus | null) => {
    if (listedHealth === undefined) return;
    const print = healthPrint(data, status);
    if (print === listedHealth) return;
    listedHealth = print;
    server.sendToolListChanged().catch(() => undefined);
  };

  /** The practice control tool answers to its name unless a served tool already has it. */
  const servesPracticeControl = (data: ToolManifest) =>
    practiceOn && data.practice !== undefined && findServedTool(data, PRACTICE_CONTROL) === undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Docs tools are always available; operation tools are config-derived and
    // fetched live. If the endpoint is unreachable, degrade to docs tools only.
    let opTools: Tool[] = [];
    let listDocs = withDocs;
    const projectId = home?.projectId ?? "";
    if (source.kind === "static" || projectId !== "") {
      try {
        await sandboxReady;
        const data = await loadOperations(projectId);
        listDocs = withDocs && servedGroup(data, group)?.docs !== false;
        const visible = visibleOf(data).tools;
        const status = await readStatus(data);
        const base = effectiveBaseUrl(data, env);
        const folded = foldedOf(data);
        const notes = changeNotes(folded);
        const mode = modeOf(data);
        noticeCodeFallback(data);
        const practiced = (t: Tool): Tool =>
          practiceOn ? { ...t, description: `${PRACTICE_TOOL_PREFIX}${t.description ?? ""}` } : t;
        opTools =
          mode === "search"
            ? searchModeTools(visible).map(practiced)
            : mode === "code"
              ? codeModeTools(codeLanguagesOf(data), visible, codeLimits, runLimits, data.codeMode).map(practiced)
              : visible.map((t) => listed(t, operationStatus(status, t, base), notes.get(t.name)));
        // The owner's chained tools follow the operation tools they are made of.
        for (const chain of data.chains ?? []) {
          if (userAllowsChain(chain, permissions)) {
            opTools.push(listedChain(chain, chainStatus(status, chain, base), notes.get(chain.name)));
          }
        }
        if (servesWhatChanged(data)) opTools.push(whatChangedTool(folded));
        if (servesPracticeControl(data)) opTools.push(practiceControlTool());
        listedHealth = healthPrint(data, status);
        listedRelease = changesOf(data)?.release;
        markSeen(data);
      } catch (err) {
        if (err instanceof UnknownGroupError) {
          // A mistyped group must not fall back to the whole project: serve
          // nothing, and say why where the client's server log shows it.
          logLine(`Error: ${err.message} Check --group / ${envName(env, "GROUP")}.\n`);
          return { tools: [] };
        }
        // Degrading to docs-only keeps the server usable, but doing it silently
        // meant a typo'd project id or an unreachable API was indistinguishable
        // from a project that genuinely has no endpoints: the tool list just
        // came back short, with nothing to explain it. Say so once, on stderr,
        // where the client's server log will show it.
        logLine(
          `Warning: could not load operation tools for project ${projectId}: ${String(err)}\n` +
            `  Serving documentation tools only. Check --project-id / ${envName(env, "PROJECT_ID")} and ${envName(env, "API_URL")}.\n`,
        );
      }
    }
    return { tools: [...(listDocs ? docsTools : []), ...opTools] };
  });

  const safeResult = (text: string, isError = false) => textResult(redact(text), isError);
  const guidesOn = readEnv(env, "ERROR_GUIDES")?.trim() !== "0";
  /**
   * The guide for a call whose request was answered with a failure, or
   * undefined when there is none to give (no answer, or guides turned off).
   */
  const errorGuideFor = (
    data: ToolManifest,
    tool: OperationTool,
    result: OperationResult,
    viaCallTool: boolean,
    step?: string,
  ) => {
    if (!guidesOn || result.failure === undefined) return undefined;
    return buildErrorGuide({
      tool,
      answer: result.failure,
      ...(data.errorGuides !== undefined ? { projectGuides: data.errorGuides } : {}),
      tools: data.tools.filter((candidate) => userAllowsTool(candidate, permissions)),
      origin: options.credentialOrigin ?? (credentialSet(env) ? "env" : "none"),
      credentialVars: credentialVarNames(data.auth, env.prefix),
      credentialSent: credentialSet(env),
      viaCallTool,
      ...(step !== undefined ? { step } : {}),
    });
  };
  /** A guided failure: the text redacted, the guide's facts as data, redacted the same way. */
  const guidedResult = (text: string, structured: ErrorGuide["structured"] & { step?: string }) => ({
    ...textResult(redact(text), true),
    structuredContent: JSON.parse(redact(JSON.stringify(structured))) as Record<string, unknown>,
  });
  /** An audit entry's `arguments`, redacted, or nothing when there were none. */
  const auditArgumentsOf = (args: Record<string, unknown>): { arguments?: string } => {
    const text = auditArguments(args, credentialSecrets(env));
    return text !== undefined ? { arguments: text } : {};
  };
  /** A call a safety limit refused: readable text, and the same facts as data. */
  const limitToolResult = (hit: LimitHit, text?: string, step?: string) => {
    const limited = limitResult(hit, sessionLimits.clock(), step);
    return { ...textResult(redact(text ?? limited.text), true), structuredContent: limited.structured };
  };
  /** A call that failed during a known outage: readable text, and the same facts as data. */
  const outageToolResult = (outage: ReturnType<typeof outageResult>) => ({
    ...textResult(redact(outage.text), true),
    structuredContent: outage.structured,
  });

  const callTool = async (
    request: { params: { name: string; arguments?: Record<string, unknown> | undefined } },
    /** Hears what an operation call did, for a code mode script to read its answer as data. */
    onOperation?: (result: OperationResult) => void,
    /** The client request this call answers: an approval prompt is sent as part of it. */
    relatedRequestId?: RequestId,
  ) => {
    const { name, arguments: args } = request.params;
    const askHere = (message: string) => ask(message, relatedRequestId);
    const a = (args ?? {}) as Record<string, unknown>;

    // Allow per-call projectId override; fall back to env/flag default. A
    // static manifest belongs to one project, so there it only steers the
    // documentation tools.
    const projectId =
      typeof a["projectId"] === "string" && a["projectId"] !== ""
        ? a["projectId"]
        : (home?.projectId ?? "");

    if (source.kind === "live" && projectId === "") {
      return safeResult(
        `Error: projectId is required. Set the ${envName(env, "PROJECT_ID")} environment variable or pass --project-id on the command line.`,
        true,
      );
    }

    // Set once `name` is known to be one of this server's tools, so an unknown
    // name an agent made up is never counted as a call to anything.
    let counted: string | undefined;
    let countedSlug: string | undefined;
    const startedAt = Date.now();
    const report = (outcome: CallOutcome) => {
      if (counted === undefined || reporter === undefined || projectId === "") return;
      const client = server.getClientVersion()?.name;
      reporter.record(projectId, {
        tool: counted,
        ...(countedSlug !== undefined && countedSlug !== "" ? { slug: countedSlug.slice(0, 512) } : {}),
        ...(group !== undefined ? { group } : {}),
        // Practice calls are counted apart, never as real ones.
        outcome: practiceOn && !servesDocs(counted) ? "practice" : outcome,
        durationMs: Date.now() - startedAt,
        ...(client !== undefined && client !== "" ? { client: client.slice(0, 64) } : {}),
        at: new Date(startedAt).toISOString(),
      });
    };

    /**
     * In practice: nothing to answer from when the owner left it off, and a
     * session past its call limit must start over. Undefined: go ahead.
     */
    const practiceRefusal = (data: ToolManifest) => {
      if (practice === undefined) return undefined;
      if (data.practice === undefined) return safeResult(PRACTICE_OFF_TEXT, true);
      if (++practice.calls > practice.callLimit) {
        return safeResult(
          `Practice session limit reached (${practice.callLimit} calls). Start a new session to keep practicing.`,
          true,
        );
      }
      return undefined;
    };
    /** Practice skips approval prompts; the agent is told one would be asked in real use. */
    const practiceApprovalNote = (text: string, asks: boolean) =>
      practiceOn && asks ? `${text}\n\nIn real use, this call asks the user to approve it before it is sent.` : text;

    /**
     * One operation call, however it was reached: by its own name, or by name
     * through `call_tool`. Every permission check lives here, so the two routes
     * cannot drift apart, and usage always names the operation itself.
     */
    const runOperation = async (
      data: ToolManifest,
      opName: string,
      opArgs: Record<string, unknown>,
      viaCallTool: boolean,
    ) => {
      const served = findServedTool(data, opName);
      if (served?.kind === "chain") {
        const { chain } = served;
        if (!userAllowsChain(chain, permissions)) {
          return safeResult(
            `Not available: ${opName} is turned off for this server (read-only mode, a deny list, or one of its steps is off).`,
            true,
          );
        }
        counted = chain.name;
        countedSlug = chainKey(chain);
        const refused = practiceRefusal(data);
        if (refused !== undefined) return refused;
        const status = await readStatus(data);
        const base = effectiveBaseUrl(data, env);
        noticeHealth(data, status);
        const send = fetchFor(data);
        // Practice sends nothing real, so it asks nothing.
        const approvalGate = practiceOn
          ? undefined
          : chainGate(chain, permissions, { capabilities: () => server.getClientCapabilities(), ask: askHere }, env.prefix);
        const limits = limitsOf(data);
        const approval = approvalOf(chainNeedsApproval(chain, permissions), chainNeedsApproval(chain, unallowed));
        let chainHit: { hit: LimitHit; step?: string } | undefined;
        /** One audit entry per write the chain attempted. */
        const auditStep = (
          step: ChainStep,
          inputs: Record<string, unknown>,
          outcome: AuditEvent["outcome"],
          status?: number,
          durationMs?: number,
        ) => {
          if (limits?.audit !== true || !isWriteCall(step.tool, limits)) return;
          audit(projectId, {
            tool: step.tool.name,
            ...(step.tool.slug !== "" ? { slug: step.tool.slug.slice(0, 512) } : {}),
            chain: chain.slug,
            method: step.tool.http.method.toUpperCase(),
            path: step.tool.http.path,
            approval,
            outcome,
            ...(status !== undefined ? { status } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...auditArgumentsOf(inputs),
          });
        };
        // Every write the whole chain would make must fit before anyone is
        // asked; past the prompt, each request is counted right before it goes.
        const gate: ChainGate | undefined =
          limits === undefined
            ? approvalGate
            : async (steps) => {
                const hit = await sessionLimits.check(projectId, chain.steps.map((s) => s.tool), limits, chain.name);
                if (hit === undefined) return approvalGate !== undefined ? approvalGate(steps) : null;
                chainHit = { hit };
                return { ok: false, held: "limited", text: `${limitResult(hit, sessionLimits.clock()).text}\n\nNothing was sent.` };
              };
        const result = await runChain(chain, data, opArgs, {
          ...(gate !== undefined ? { gate } : {}),
          ...(limits !== undefined
            ? {
                beforeStep: async (step: ChainStep, inputs: Record<string, unknown>) => {
                  const hit = await sessionLimits.take(projectId, step.tool, limits);
                  if (hit === undefined) return null;
                  chainHit = { hit, step: step.id };
                  auditStep(step, inputs, "limited");
                  return limitResult(hit, sessionLimits.clock(), step.id).text;
                },
              }
            : {}),
          env,
          ...(send !== undefined ? { fetch: send } : {}),
          // Each request a chain sends counts for its endpoint too, marked
          // with the chain, so an endpoint's numbers stay whole.
          onStep: ({ step, inputs, ok, durationMs, failedStatus, status: answered }) => {
            auditStep(step, inputs, ok ? "ok" : "error", answered, durationMs);
            record(projectId, {
              tool: step.tool.name,
              ...(step.tool.slug !== "" ? { slug: step.tool.slug.slice(0, 512) } : {}),
              chain: chain.slug,
              outcome: practiceOn
                ? "practice"
                : ok
                ? "ok"
                : failedStatus !== undefined && isKnownOutage(operationStatus(status, step.tool, base), failedStatus)
                  ? "outage"
                  : "error",
              durationMs,
            });
          },
        });
        // Held before anything was sent: every write it planned is on the record.
        if (result.held === "declined" || result.held === "blocked" || (result.held === "limited" && chainHit?.step === undefined)) {
          for (const step of chain.steps) auditStep(step, opArgs, result.held);
        }
        if (result.held === "limited" && chainHit !== undefined) {
          report("limited");
          // Mid-chain, the text says which steps were already sent: those stand.
          return limitToolResult(chainHit.hit, result.text, chainHit.step);
        }
        if (result.failedStep !== undefined && result.failedStatus !== undefined) {
          const found = operationStatus(status, result.failedStep, base);
          if (found !== undefined && isKnownOutage(found, result.failedStatus)) {
            report("outage");
            return outageToolResult(
              outageResult({ ...found, step: result.failedStep }, chain.name, result.failedStatus, result.text),
            );
          }
          const note = found !== undefined ? statusNote({ ...found, step: result.failedStep }) : undefined;
          const guide = errorGuideFor(data, result.failedStep, result, viaCallTool, result.failedStep.name);
          if (guide !== undefined) {
            report("error");
            // A chain's text leads with the step and ends with what was already
            // sent, so its guide goes under all of that.
            return guidedResult(
              `${result.text}\n\n${guide.text}${note !== undefined ? `\n\n${note}` : ""}`,
              { ...guide.structured, step: result.failedStep.name },
            );
          }
          if (note !== undefined) {
            report("error");
            return safeResult(`${result.text}\n\n${note}`, true);
          }
        }
        report(result.held ?? (result.ok ? "ok" : "error"));
        return safeResult(practiceApprovalNote(result.text, result.ok && chainNeedsApproval(chain, basePermissions)), !result.ok);
      }
      const tool = served?.tool;
      if (tool !== undefined && !userAllowsTool(tool, permissions)) {
        // Not listed for this user, so to the agent it does not exist. Saying
        // why helps the person reading the transcript, not the model.
        return safeResult(
          `Not available: ${opName} is turned off for this server (read-only mode, a deny list, or the project's own settings).`,
          true,
        );
      }
      if (tool === undefined) {
        // A name an earlier release served: say where it went, not "unknown".
        const changes = changesOf(data);
        const moved =
          changes !== undefined && !hiddenFrom(data)(opName)
            ? oldNameAnswer(changes, opName, (current) => {
                const found = findServedTool(data, current);
                if (found === undefined) return undefined;
                if (found.kind === "chain") return userAllowsChain(found.chain, permissions) ? found.chain : undefined;
                return userAllowsTool(found.tool, permissions) ? found.tool : undefined;
              })
            : undefined;
        if (moved !== undefined) {
          return { ...textResult(redact(moved.text), true), structuredContent: moved.structured };
        }
        return safeResult(viaCallTool ? unknownOperation(indexOf(data), opName) : `Unknown tool: ${opName}`, true);
      }
      counted = tool.name;
      countedSlug = tool.slug;
      const refused = practiceRefusal(data);
      if (refused !== undefined) return refused;
      const approvalGate = practiceOn
        ? undefined
        : sendGate(tool, permissions, { capabilities: () => server.getClientCapabilities(), ask: askHere }, env.prefix);
      const limits = limitsOf(data);
      let hit: LimitHit | undefined;
      /** Set once a request was built: only then is there a write to audit. */
      let built = false;
      // Checked before the prompt, so nobody approves a call that cannot run,
      // and counted after it, right before the request goes out.
      const gate: SendGate | undefined =
        limits === undefined
          ? approvalGate
          : async (pending) => {
              built = true;
              hit = await sessionLimits.check(projectId, [tool], limits, tool.name);
              if (hit === undefined) {
                const held = approvalGate !== undefined ? await approvalGate(pending) : null;
                if (held !== null) return held;
                hit = await sessionLimits.take(projectId, tool, limits);
              }
              return hit === undefined ? null : { ok: false, held: "limited", text: limitResult(hit, sessionLimits.clock()).text };
            };
      const sentAt = Date.now();
      const result = await executeOperation(tool, data, opArgs, gate, env, fetchFor(data));
      onOperation?.(result);
      if (limits?.audit === true && built && result.held !== "dry_run" && isWriteCall(tool, limits)) {
        audit(projectId, {
          tool: tool.name,
          ...(tool.slug !== "" ? { slug: tool.slug.slice(0, 512) } : {}),
          method: tool.http.method.toUpperCase(),
          path: tool.http.path,
          approval: approvalOf(needsApproval(tool, permissions), needsApproval(tool, unallowed)),
          outcome: result.held ?? (result.ok ? "ok" : "error"),
          ...(result.response !== undefined ? { status: result.response.status } : {}),
          durationMs: Date.now() - sentAt,
          ...auditArgumentsOf(opArgs),
          at: new Date(sentAt).toISOString(),
        });
      }
      if (result.held === "limited" && hit !== undefined) {
        report("limited");
        return limitToolResult(hit);
      }
      if (result.failedStatus !== undefined) {
        // Read after the call, never before: a call is not held back over a
        // status, since the API may have recovered since the last check.
        const status = await readStatus(data);
        noticeHealth(data, status);
        const found = operationStatus(status, tool, effectiveBaseUrl(data, env));
        if (found !== undefined && isKnownOutage(found, result.failedStatus)) {
          report("outage");
          return outageToolResult(outageResult(found, tool.name, result.failedStatus, result.text));
        }
        const note = found !== undefined ? statusNote(found) : undefined;
        const guide = errorGuideFor(data, tool, result, viaCallTool);
        if (guide !== undefined) {
          report("error");
          // Right under the request line, above a body that may be long.
          const split = result.text.indexOf("\n\n");
          const text = split === -1
            ? `${result.text}\n\n${guide.text}`
            : `${result.text.slice(0, split)}\n\n${guide.text}\n\n${result.text.slice(split + 2)}`;
          return guidedResult(note !== undefined ? `${text}\n\n${note}` : text, guide.structured);
        }
        if (note !== undefined) {
          report("error");
          return safeResult(`${result.text}\n\n${note}`, true);
        }
      }
      report(result.held ?? (result.ok ? "ok" : "error"));
      // Through call_tool the agent may not have read the schema yet: hand it
      // over with the error, so the retry is right the first time.
      const text =
        viaCallTool && result.invalidArgs === true
          ? `${result.text}

Input schema for ${tool.name}: ${JSON.stringify(tool.inputSchema)}`
          : practiceApprovalNote(result.text, result.ok && needsApproval(tool, basePermissions));
      return safeResult(text, !result.ok);
    };

    const runMetaTool = async (data: ToolManifest, meta: string) => {
      if (meta === CALL_TOOL) {
        const target = typeof a["name"] === "string" ? a["name"].trim() : "";
        if (target === "") {
          return textResult(`Error: ${CALL_TOOL} needs the name of an operation. Find one with ${SEARCH_TOOLS}.`, true);
        }
        if (
          isMetaTool(target) ||
          servesDocs(target) ||
          (target === WHAT_CHANGED && servesWhatChanged(data)) ||
          (target === PRACTICE_CONTROL && servesPracticeControl(data))
        ) {
          return textResult(`Error: ${target} is not one of the API's operations. Call it directly.`, true);
        }
        const opArgs = callArguments(a["arguments"]);
        if (opArgs === null) {
          return textResult(`Error: ${CALL_TOOL} takes the operation's arguments as an object.`, true);
        }
        return runOperation(data, target, opArgs, true);
      }
      const visible = visibleOf(data).tools;
      const status = await readStatus(data);
      const base = effectiveBaseUrl(data, env);
      const healthOf = (t: OperationTool) => operationStatus(status, t, base);
      const notes = changeNotes(foldedOf(data));
      const changedOf = (t: OperationTool) => {
        const change = notes.get(t.name)?.change;
        if (change === undefined) return undefined;
        return change.status === "added" ? "new" : change.breaking ? "breaking" : "changed";
      };
      if (meta === SEARCH_TOOLS) {
        return textResult(searchText(indexOf(data), visible, a, permissions, healthOf, changedOf));
      }
      if (meta === DESCRIBE_TOOL) {
        return textResult(describeText(indexOf(data), a, permissions, (t) => listed(t, healthOf(t), notes.get(t.name))));
      }
      return textResult(groupsText(visible));
    };

    try {
      // Operation tools (executable, config-derived) aren't in the static docs
      // set, so resolve + perform the real API call for them.
      if (!servesDocs(name) || !(await docsServed(projectId))) {
        const data = await loadOperations(projectId);
        // The search tools answer to their names unless a served tool already
        // has one, in either mode: a client that listed them just before the
        // owner switched modes can still finish what it started.
        noticeRelease(data);
        markSeen(data);
        if (name === WHAT_CHANGED && servesWhatChanged(data)) {
          const answer = whatChangedResult(changesOf(data)!, a, { sessionSince, hidden: hiddenFrom(data) });
          return {
            ...textResult(redact(answer.text), answer.isError === true),
            structuredContent: JSON.parse(redact(JSON.stringify(answer.structured))) as Record<string, unknown>,
          };
        }
        if (name === PRACTICE_CONTROL && practice !== undefined && servesPracticeControl(data)) {
          const answer = runPracticeControl(data, practice, a, (target) => {
            const found = findServedTool(data, target);
            if (found === undefined) return false;
            return found.kind === "chain" ? userAllowsChain(found.chain, permissions) : userAllowsTool(found.tool, permissions);
          });
          return safeResult(answer.text, answer.isError);
        }
        if (isMetaTool(name) && findServedTool(data, name) === undefined) {
          return await runMetaTool(data, name);
        }
        if (isCodeTool(name) && findServedTool(data, name) === undefined) {
          await sandboxReady;
          const languages = codeLanguagesOf(data);
          if (languages.length > 0) {
            counted = name;
            const answer =
              name === DESCRIBE_SDK ? describeSdk(data, languages, a) : await runCode(data, languages, a, relatedRequestId);
            report(answer.isError === true ? "error" : "ok");
            return answer;
          }
        }
        return await runOperation(data, name, a, false);
      }

      counted = name;
      // `servesDocs` guarantees an Octri project to read from.
      const text = await runDocsTool(name, a, home?.apiUrl ?? "", projectId);
      report("ok");
      return safeResult(text);
    } catch (err) {
      report("error");
      const message = err instanceof Error ? err.message : String(err);
      return safeResult(`Error: ${message}`, true);
    }
  };

  // ── Code mode ─────────────────────────────────────────────────────────────

  /** The language a code tool call names, or the first offered; an unoffered one is an error. */
  const pickLanguage = (languages: CodeLanguage[], raw: unknown): CodeLanguage | string => {
    if (raw === undefined || raw === "") return languages[0]!;
    if (isCodeLanguage(raw) && languages.includes(raw)) return raw;
    return `Error: ${String(raw)} is not offered by this server. Use ${languages.join(" or ")}.`;
  };

  const describeSdk = (data: ToolManifest, languages: CodeLanguage[], a: Record<string, unknown>) => {
    const language = pickLanguage(languages, a["language"]);
    if (!isCodeLanguage(language)) return textResult(language, true);
    const methods = sdkMethods(visibleOf(data).tools, data.codeMode!, language);
    const names = Array.isArray(a["names"]) ? a["names"].filter((n): n is string => typeof n === "string") : undefined;
    const text = describeSdkText(
      methods,
      {
        language,
        ...(typeof a["query"] === "string" ? { query: a["query"] } : {}),
        ...(names !== undefined ? { names } : {}),
        ...(typeof a["group"] === "string" ? { group: a["group"] } : {}),
      },
      (t) => !practiceOn && needsApproval(t, permissions),
    );
    return safeResult(text);
  };

  /**
   * One script. Each SDK call it makes comes back here and is run as an
   * ordinary call to that operation, so it is checked, approved, practised,
   * counted and redacted exactly like one. Only the operations this user can
   * see are reachable, by their tool names.
   */
  const runCode = async (
    data: ToolManifest,
    languages: CodeLanguage[],
    a: Record<string, unknown>,
    relatedRequestId?: RequestId,
  ) => {
    const language = pickLanguage(languages, a["language"]);
    if (!isCodeLanguage(language)) return textResult(language, true);
    const code = typeof a["code"] === "string" ? a["code"] : "";
    if (code.trim() === "") return textResult(`Error: ${RUN_CODE} needs the script in \`code\`.`, true);
    if (code.length > runLimits.sourceChars) {
      return textResult(`Error: the script is over ${runLimits.sourceChars} characters. Keep it short: let the SDK do the work.`, true);
    }
    const sandbox = codeSandbox;
    if (sandbox === undefined) return textResult("Error: this server cannot run scripts.", true);
    const methods = sdkMethods(visibleOf(data).tools, data.codeMode!, language);
    const program = language === "typescript" ? typeScriptProgram(methods, code) : pythonProgram(methods, code);
    const byName = new Map(methods.map((m) => [m.tool.name, m.tool]));
    const calls: CallRecord[] = [];
    const notes: string[] = [];
    let approvals = 0;
    const refuse = (kind: string, message: string) => JSON.stringify({ ok: false, error: { kind, message } });
    const bridge = async (toolName: string, argsJson: string): Promise<string> => {
      const tool = byName.get(toolName);
      if (tool === undefined) return refuse("invalid", `${toolName} is not one of this server's SDK methods.`);
      if (calls.length >= runLimits.calls) {
        return refuse("limit", `A script may make ${runLimits.calls} API calls per run. Return what you have, then run again for the rest.`);
      }
      let args: unknown;
      try {
        args = JSON.parse(argsJson, safeReviver);
      } catch {
        return refuse("invalid", "The arguments could not be read as JSON.");
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return refuse("invalid", `${toolName} takes one object of arguments.`);
      }
      const asks = !practiceOn && !permissions.dryRun && needsApproval(tool, permissions);
      if (asks && ++approvals > runLimits.approvals) {
        return refuse("limit", `A script may ask the user to approve ${runLimits.approvals} calls per run. Split the work into smaller runs.`);
      }
      let op: OperationResult | undefined;
      const answer = await callTool(
        { params: { name: toolName, arguments: args as Record<string, unknown> } },
        (r) => {
          op = r;
        },
        relatedRequestId,
      );
      const first = answer.content[0];
      const text = first !== undefined && first.type === "text" ? first.text : "";
      const structured = (answer as { structuredContent?: Record<string, unknown> }).structuredContent;
      const envelope = envelopeFor(
        op,
        {
          text,
          isError: answer.isError === true,
          outage: structured?.["error"] === "known_outage",
          ...(structured?.["error"] === "limit_reached" ? { limit: structured } : {}),
        },
        redact,
      );
      const done = op as OperationResult | undefined;
      calls.push({
        tool: toolName,
        method: tool.http.method.toUpperCase(),
        outcome: envelope.ok
          ? done?.response !== undefined ? String(done.response.status) : "dry run, not sent"
          : envelope.error.kind === "declined"
            ? "declined by the user"
            : envelope.error.kind === "approval_required"
              ? "not sent, needs approval"
              : envelope.error.kind === "limit"
                ? "not sent, limit reached"
              : envelope.error.status !== undefined ? `failed ${envelope.error.status}` : "failed",
      });
      if (envelope.ok && envelope.note !== undefined) notes.push(envelope.note);
      return JSON.stringify(envelope);
    };
    const outcome = await sandbox.run(
      { language, source: program.source, lineOffset: program.lineOffset, lineCount: program.lineCount, limits: codeLimits },
      bridge,
    );
    const text = runResultText(language, outcome, calls, notes, runLimits.resultChars);
    return {
      ...textResult(redact(text), outcome.status !== "ok"),
      structuredContent: JSON.parse(redact(JSON.stringify({ status: outcome.status, calls }))) as Record<string, unknown>,
    };
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await callTool(request, undefined, extra.requestId);
    // Documentation answers are real; everything else in practice is not.
    return practiceOn && !servesDocs(request.params.name) ? markPractice(result) : result;
  });

  // ── Prompts and resources ─────────────────────────────────────────────────
  //
  // Both come from the same manifest as the tools, narrowed to the group the
  // same way. A server that cannot load the manifest lists none.

  const loadQuietly = async (): Promise<ToolManifest | undefined> => {
    const projectId = home?.projectId ?? "";
    if (source.kind !== "static" && projectId === "") return undefined;
    try {
      return await loadOperations(projectId);
    } catch {
      return undefined;
    }
  };
  // Resource contents are read from the Octri project, like the docs tools.
  const servesResources = withDocs;

  const servedPrompts = (all: PromptTemplate[]) => all.filter((p) => options.skipPrompts?.has(p.name) !== true);

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const data = await loadQuietly();
    return { prompts: listPrompts(servedPrompts(data?.prompts ?? [])) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const data = await loadQuietly();
    const prompts = servedPrompts(data?.prompts ?? []);
    const result = getPrompt(prompts, request.params.name, request.params.arguments ?? {});
    const prompt = prompts.find((p) => p.name === request.params.name);
    if (prompt !== undefined) {
      record(home?.projectId ?? "", { tool: prompt.name, slug: `prompt:${prompt.slug}`, outcome: "ok", durationMs: 0 });
    }
    return result;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if (!servesResources) return { resources: [] };
    const data = await loadQuietly();
    return { resources: listResources(data?.resources ?? []) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const data = servesResources ? await loadQuietly() : undefined;
    const resource = findResource(data?.resources ?? [], request.params.uri);
    const projectId = home?.projectId ?? "";
    const startedAt = Date.now();
    try {
      const result = await readResource(home?.apiUrl ?? "", projectId, resource);
      record(projectId, { tool: resource.slug, slug: `resource:${resource.slug}`, outcome: "ok", durationMs: Date.now() - startedAt });
      return result;
    } catch (err) {
      record(projectId, { tool: resource.slug, slug: `resource:${resource.slug}`, outcome: "error", durationMs: Date.now() - startedAt });
      throw err;
    }
  });

  return server;
}
