import type { FailedAnswer, OperationTool, ParamBinding } from "./operations.js";

// ─── Error guides ──────────────────────────────────────────────────────────────
//
// A failed call comes back with a short guide on how to fix it, so the agent
// corrects the next try instead of repeating the same request. Three layers,
// most specific first (mirrors `mcp-error-guides.ts` in @octri/shared; this
// package does not depend on it):
//
//   1. the operation's own docs (`tool.errorHelp`), by status then class;
//   2. the project's guides (`manifest.errorGuides`): the owner's "Error
//      guidance by status", over the wording most operations share;
//   3. a built-in hint for the status class, used only when 1 and 2 are silent.
//
// Around whichever layer answers go the facts only the server knows: the field
// the error body names and its slot in the input schema, a documented error
// code, `Retry-After`, and who can fix a refused credential. A known outage is
// decided before any of this and wins. The caller redacts the result.

/** The guide never grows past this, however much the layers say. */
export const ERROR_GUIDE_MAX_CHARS = 1200;
/** Through call_tool a rejected call gets the input schema too, up to this size. */
export const ERROR_GUIDE_SCHEMA_MAX_CHARS = 4000;
/** No guide waits longer than this for a retry, whatever `Retry-After` says. */
const RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60;

/**
 * Where the server's API credential came from, which decides who can fix a
 * refused one: the person running the server (`env`, `keychain`, `none`), the
 * project owner (`stored`, an installation's key), the person who signed in
 * (`signin`), or the client's own configuration (`client`, hosted headers).
 */
export type CredentialOrigin = "env" | "keychain" | "none" | "stored" | "signin" | "client";

export interface ErrorGuideInput {
  tool: OperationTool;
  answer: FailedAnswer;
  /** The project's guides. */
  projectGuides?: Record<string, string>;
  /** The tools the agent can call now, for pointing a 404 at a list tool. */
  tools?: readonly OperationTool[];
  origin: CredentialOrigin;
  /** The variables the credential is read from, for the `env` and `none` hints. */
  credentialVars?: readonly string[];
  /** The call came through call_tool, where the agent may not have read the schema. */
  viaCallTool?: boolean;
  /** For a chained tool: the step that failed, named in the heading. */
  step?: string;
  now?: number;
}

export interface ErrorGuide {
  /** The guide block, without the response it explains. */
  text: string;
  structured: {
    error: "request_failed";
    tool: string;
    statusCode: number;
    /** Which layer the main advice came from. */
    source: "operation" | "project" | "built_in";
    /** The input the error body pointed at. */
    field?: string;
    /** The documented error code the body carried. */
    code?: string;
    retryAfterSeconds?: number;
    retryAfter?: string;
  };
}

// ─── Reading the error body ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A field reference as an error body gives it: a pointer, a dotted path, FastAPI's `loc` array. */
function fieldPath(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string | number => typeof part === "string" || typeof part === "number").map(String);
    return parts.length > 0 ? parts : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parts = value
    .trim()
    .replace(/^#?\//, "")
    .split(/[/.[\]]+/)
    .filter((part) => part !== "");
  return parts.length > 0 ? parts : undefined;
}

const FIELD_KEYS = ["field", "param", "parameter", "path", "loc", "pointer", "property", "attribute", "name"] as const;
// `detail` is FastAPI's list; elsewhere it is a sentence, which the array check skips.
const LIST_KEYS = ["errors", "details", "detail", "issues", "violations", "invalid_params", "invalidParams", "fields"] as const;
const CODE_KEYS = ["code", "issue", "error_code", "errorCode", "type", "reason"] as const;

/** Every error-ish object in the body: the root, a nested `error`, and the entries of the usual lists. */
function errorObjects(body: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 3) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    found.push(node);
    if (isRecord(node["error"])) visit(node["error"], depth + 1);
    if (isRecord(node["source"])) found.push(node["source"]);
    for (const key of LIST_KEYS) {
      const list = node[key];
      if (Array.isArray(list)) visit(list, depth + 1);
      // `{ errors: { email: ["is taken"] } }`: the keys are the fields.
      else if (isRecord(list)) for (const name of Object.keys(list).slice(0, 20)) found.push({ field: name });
    }
  };
  visit(body, 0);
  return found;
}

function bodyFields(objects: Record<string, unknown>[]): string[][] {
  const paths: string[][] = [];
  for (const object of objects) {
    for (const key of FIELD_KEYS) {
      // `name` names a field only beside a message; alone it is often the error's own name.
      if (key === "name" && object["message"] === undefined && object["msg"] === undefined) continue;
      const path = fieldPath(object[key]);
      if (path !== undefined) paths.push(path);
    }
  }
  return paths;
}

function bodyCodes(objects: Record<string, unknown>[]): string[] {
  const codes: string[] = [];
  for (const object of objects) {
    for (const key of CODE_KEYS) {
      const value = object[key];
      if (typeof value === "string" && value.trim() !== "") codes.push(value.trim());
    }
    if (typeof object["error"] === "string" && object["error"].trim() !== "") codes.push(object["error"].trim());
  }
  return codes;
}

// ─── Matching the body to the tool ────────────────────────────────────────────

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface InputSlot {
  /** The argument as the agent passes it: `email`, or `body.email`. */
  argument: string;
  schema: Record<string, unknown>;
  required: boolean;
}

function requiredOf(node: unknown): string[] {
  const raw = isRecord(node) ? node["required"] : undefined;
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
}

/** The input-schema slot an API field name lands in, through the wire-name bindings. */
function inputSlot(tool: OperationTool, path: readonly string[]): InputSlot | undefined {
  const root = tool.inputSchema as unknown;
  const properties = isRecord(root) && isRecord(root["properties"]) ? root["properties"] : {};
  const body = properties["body"];
  const bodyProperties = isRecord(body) && isRecord(body["properties"]) ? body["properties"] : {};
  const http = tool.http;
  const bindings: ParamBinding[] = [
    ...http.pathParams,
    ...http.queryParams,
    ...(http.headerParams ?? []),
    ...(http.cookieParams ?? []),
    ...http.bodyParams,
  ];

  // Skip the containers an error path often starts with (`body.email`, `["body", "email"]`).
  const segments = path.filter((part) => !/^(?:body|query|path|header|cookie|data|request|\d+)$/i.test(part));
  for (const segment of segments) {
    const want = normalized(segment);
    const binding = bindings.find((b) => normalized(b.wireName) === want || normalized(b.name) === want);
    const names = [binding?.name, segment].filter((name): name is string => name !== undefined);
    for (const name of names) {
      const top = Object.keys(properties).find((key) => key !== "body" && normalized(key) === normalized(name));
      if (top !== undefined && isRecord(properties[top])) {
        return { argument: top, schema: properties[top], required: requiredOf(root).includes(top) };
      }
      const nested = Object.keys(bodyProperties).find((key) => normalized(key) === normalized(name));
      if (nested !== undefined && isRecord(bodyProperties[nested])) {
        return { argument: `body.${nested}`, schema: bodyProperties[nested], required: requiredOf(body).includes(nested) };
      }
    }
  }
  return undefined;
}

/** One line on what the slot accepts: type, format, allowed values, required. */
function describeSlot(slot: InputSlot): string {
  const { schema } = slot;
  const parts: string[] = [];
  const type = Array.isArray(schema["type"]) ? schema["type"].join(" or ") : schema["type"];
  if (typeof type === "string") parts.push(type);
  if (typeof schema["format"] === "string") parts.push(`format ${schema["format"]}`);
  if (typeof schema["pattern"] === "string") parts.push(`pattern ${schema["pattern"]}`);
  for (const [key, label] of [["minLength", "min length"], ["maxLength", "max length"], ["minimum", "min"], ["maximum", "max"]] as const) {
    if (typeof schema[key] === "number") parts.push(`${label} ${schema[key]}`);
  }
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"].slice(0, 10).map((v) => JSON.stringify(v));
    parts.push(`one of ${values.join(", ")}${schema["enum"].length > 10 ? ", …" : ""}`);
  }
  parts.push(slot.required ? "required" : "optional");
  return parts.join(", ");
}

/** The GET tool that lists what a `/things/{id}` tool reads one of, when there is one. */
function listTool(tool: OperationTool, tools: readonly OperationTool[]): { tool: OperationTool; param: string } | undefined {
  const match = /^(.*)\/\{([^}]+)\}\/?$/.exec(tool.http.path);
  if (match === null || match[1] === undefined || match[2] === undefined || match[1] === "") return undefined;
  const parent = match[1];
  const found = tools.find(
    (candidate) => candidate !== tool && candidate.http.method.toUpperCase() === "GET" && candidate.http.path.replace(/\/$/, "") === parent,
  );
  if (found === undefined) return undefined;
  const binding = tool.http.pathParams.find((p) => p.wireName === match[2]);
  return { tool: found, param: binding?.name ?? match[2] };
}

// ─── Retry-After ──────────────────────────────────────────────────────────────

/** `Retry-After` as seconds from now: delta-seconds or an HTTP date. Undefined when unreadable. */
export function retryAfterSeconds(header: string | undefined, now: number = Date.now()): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  let seconds: number;
  if (/^\d+$/.test(value)) seconds = Number(value);
  else {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(Math.max(seconds, 0), RETRY_AFTER_MAX_SECONDS);
}

function humanSeconds(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} min`;
  return `about ${Math.round(seconds / 3600)} h`;
}

// ─── Built-in hints ───────────────────────────────────────────────────────────

function credentialHint(status: 401 | 403, origin: CredentialOrigin, vars: readonly string[]): string {
  const named = vars.length > 0 ? vars.join(" or ") : "the API credential variable";
  if (status === 401) {
    switch (origin) {
      case "stored":
        return "The API refused the key the project owner stored for this installation. Changing the arguments will not help: tell the user the stored key needs updating in Octri.";
      case "signin":
        return "The API refused the signed-in session: it expired or was revoked. Changing the arguments will not help: ask the user to reconnect this MCP server and sign in again.";
      case "client":
        return "The API refused the credential this MCP client sends with each request. Changing the arguments will not help: ask the user to check the key configured for this server in their client.";
      case "keychain":
        return "The API refused the credential saved in the system keychain. Changing the arguments will not help: ask the user to run this server's `login` command again with a valid key.";
      case "none":
        return `No API credential is set, and this endpoint needs one. Ask the user to set ${named} (or run this server's \`login\` command).`;
      case "env":
        return `The API refused the credential in ${named}. Changing the arguments will not help: ask the user to check that value.`;
    }
  }
  switch (origin) {
    case "signin":
      return "The signed-in account is not allowed to do this (a missing permission or scope). Tell the user: signing in with an account that has access, or granting it, fixes it; retrying does not.";
    case "stored":
      return "The key the project owner stored for this installation is not allowed to do this. Tell the user; retrying does not help.";
    default:
      return "The credential is valid but not allowed to do this (a missing permission, scope or plan). Tell the user; retrying with the same credential does not help.";
  }
}

/**
 * For a write that failed on the API's side: it may have happened anyway.
 * Said whatever the docs say, since a blind retry can do it twice.
 */
function writeWarning(tool: OperationTool, status: number): string | undefined {
  const method = tool.http.method.toUpperCase();
  const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (status < 500 || (!write && tool.destructive !== true)) return undefined;
  return `This was a ${method}: check whether it took effect (read the resource back) before retrying, or it may happen twice.`;
}

function builtInHint(status: number): string {
  if (status === 400 || status === 422) {
    return "The API rejected the arguments. Find the field the error body names, fix that value against the input schema (type, format, allowed values), then retry once.";
  }
  if (status === 404) {
    return "Nothing was found at that address: an id or path value is wrong, or the resource no longer exists. Do not retry with the same value.";
  }
  if (status === 405 || status === 406 || status === 415 || status === 501) {
    return "The API refused the method or content type. This is the server's setup, not the arguments: tell the user instead of retrying.";
  }
  if (status === 409) {
    return "The request conflicts with the resource's current state (a duplicate, or it changed since it was read). Read the current state, then retry with values that fit it.";
  }
  if (status === 410) return "The resource is gone for good. Do not retry; tell the user.";
  if (status === 413) return "The request is too large. Send less (fewer items, a smaller body or file), then retry.";
  if (status === 429) return "Rate limited. Wait before retrying, and slow down repeated calls.";
  if (status >= 500) {
    return "The API failed on its side; the arguments are probably fine. Retry once after a short wait; if it fails again, tell the user.";
  }
  return "The API refused the request. Read the error body, fix what it names, then retry.";
}

// ─── The guide ────────────────────────────────────────────────────────────────

function lookup(guides: Record<string, string> | undefined, status: number): string | undefined {
  if (guides === undefined) return undefined;
  const exact = guides[String(status)]?.trim();
  if (exact !== undefined && exact !== "") return exact;
  const byClass = guides[`${String(status).charAt(0)}xx`]?.trim();
  return byClass !== undefined && byClass !== "" ? byClass : undefined;
}

/** Lines joined until the budget runs out; a line that does not fit is cut at a word. */
function capLines(lines: readonly string[], max: number): string {
  let out = "";
  for (const line of lines) {
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length <= max) {
      out = next;
      continue;
    }
    const room = max - out.length - (out === "" ? 0 : 1) - 1;
    if (room > 40) {
      const cut = line.slice(0, room);
      const space = cut.lastIndexOf(" ");
      out = `${out === "" ? "" : `${out}\n`}${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
    }
    break;
  }
  return out;
}

/** The variables the server reads the credential for `auth` from, as named for the person running it. */
export function credentialVarNames(auth: string, prefix: string): string[] {
  switch (auth) {
    case "bearer":
    case "oauth2":
      return [`${prefix}_API_TOKEN`];
    case "apiKey":
      return [`${prefix}_API_KEY`];
    case "basic":
      return [`${prefix}_API_USERNAME`, `${prefix}_API_PASSWORD`];
    default:
      return [];
  }
}

/** The guide for one failed answer. Never throws: a body it cannot read just matches nothing. */
export function buildErrorGuide(input: ErrorGuideInput): ErrorGuide {
  const { tool, answer } = input;
  const status = answer.status;
  const now = input.now ?? Date.now();

  const fromTool = lookup(tool.errorHelp, status);
  const fromProject = fromTool === undefined ? lookup(input.projectGuides, status) : undefined;
  const documented = fromTool ?? fromProject;
  const source = fromTool !== undefined ? "operation" : fromProject !== undefined ? "project" : "built_in";

  const objects = errorObjects(parseJson(answer.body));
  let slot: InputSlot | undefined;
  for (const path of bodyFields(objects)) {
    slot = inputSlot(tool, path);
    if (slot !== undefined) break;
  }
  const codes = bodyCodes(objects);
  const catalogued = (tool.errors ?? []).find(
    (entry) => codes.some((code) => code.toLowerCase() === entry.issue.toLowerCase()) && (entry.status === String(status) || entry.status === ""),
  ) ?? (tool.errors ?? []).find((entry) => codes.some((code) => code.toLowerCase() === entry.issue.toLowerCase()));
  if (slot === undefined && catalogued?.field !== undefined) slot = inputSlot(tool, fieldPath(catalogued.field) ?? []);

  const lines: string[] = [];
  if (documented !== undefined) lines.push(`From the API's docs: ${documented}`);
  if (catalogued !== undefined) {
    lines.push(
      `Documented error ${catalogued.status} ${catalogued.issue}${catalogued.scenario !== undefined ? `: ${catalogued.scenario}` : ""}.`,
    );
  }
  if (slot !== undefined) lines.push(`The error points at argument \`${slot.argument}\` (${describeSlot(slot)}). Fix that value.`);

  if (status === 401 || status === 403) {
    lines.push(credentialHint(status, input.origin, input.credentialVars ?? []));
  } else if (documented === undefined) {
    lines.push(builtInHint(status));
  }
  const warning = writeWarning(tool, status);
  if (warning !== undefined) lines.push(warning);

  if (status === 404 && slot === undefined) {
    const list = listTool(tool, input.tools ?? []);
    if (list !== undefined) lines.push(`To find a valid \`${list.param}\`, call \`${list.tool.name}\` first.`);
  }

  const wait = retryAfterSeconds(answer.retryAfter, now);
  if (wait !== undefined && (status === 429 || status === 503)) {
    lines.push(`The API asked for a wait: do not retry before ${new Date(now + wait * 1000).toISOString()} (${humanSeconds(wait)}).`);
  } else if (status === 429) {
    lines.push("No Retry-After was sent: wait a few seconds, then back off further each time it repeats.");
  }

  const heading = input.step !== undefined ? `How to fix step ${input.step} (${status}):` : `How to fix this call (${status}):`;
  let text = `${heading}\n${capLines(lines, ERROR_GUIDE_MAX_CHARS - heading.length - 1)}`;
  if (input.viaCallTool === true && (status === 400 || status === 422)) {
    const schema = JSON.stringify(tool.inputSchema);
    if (schema.length <= ERROR_GUIDE_SCHEMA_MAX_CHARS) text += `\n\nInput schema for ${tool.name}: ${schema}`;
    else text += `\n\nThe input schema for ${tool.name} is large: call describe_tool to read it.`;
  }

  return {
    text,
    structured: {
      error: "request_failed",
      tool: tool.name,
      statusCode: status,
      source,
      ...(slot !== undefined ? { field: slot.argument } : {}),
      ...(catalogued !== undefined ? { code: catalogued.issue } : {}),
      ...(wait !== undefined ? { retryAfterSeconds: wait, retryAfter: new Date(now + wait * 1000).toISOString() } : {}),
    },
  };
}
