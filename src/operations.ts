import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { apiFetch } from "./api-client.js";
import { DEFAULT_ENV_PREFIX, envName, processEnv, readEnv, type EnvSource } from "./env.js";
import type { ChainTool } from "./chains.js";
import type { CodeModeManifest } from "./code-sdk.js";
import type { PracticeData } from "./practice.js";
import type { ToolChanges } from "./changes.js";
import type { ToolGroup } from "./groups.js";
import type { ToolLimits } from "./limits.js";
import type { PromptTemplate } from "./prompts.js";
import type { ResourceEntry } from "./resources.js";
import type { ToolPolicy } from "./permissions.js";
import { encodeQuerystring } from "./querystring.js";
import type { ToolMode } from "./tool-search.js";

// Published independently: mirror the shared RFC token validator here.
const HTTP_METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isHttpMethodToken(value: unknown): value is string {
  return typeof value === "string" && HTTP_METHOD_TOKEN.test(value);
}

// ─── Operation tools (executable, config-derived) ───────────────────────────────
//
// One tool per included endpoint, shaped by the owner's SDK Studio config
// (names, doc comments, inclusion, deprecation). Unlike the docs tools above,
// these actually PERFORM the API call. Fetched from the public tools endpoint,
// which returns each tool's JSON-Schema input + an `http` execution mapping.

export interface ParamBinding {
  name: string;
  wireName: string;
  /** Wire schema retained for serializer decisions and compatibility. */
  schema?: Record<string, unknown>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

interface HttpConstant {
  location: "path" | "query" | "header" | "cookie" | "body";
  wireName: string;
  value: string | number | boolean;
}

interface RequestBodyMapping {
  /** OpenAPI media type selected when this operation was projected. */
  contentType?: string;
  /** Present for body-bearing operations, including root array/text/binary bodies. */
  required?: boolean;
  schema?: Record<string, unknown>;
  encoding?: Record<string, { contentType?: string; headers?: Record<string, unknown>; style?: string; explode?: boolean }>;
}

/** OpenAPI 3.2 representation of the entire URL query, never a named pair. */
interface QuerystringMapping {
  name: string;
  inputName?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  content: Record<string, unknown>;
}

export interface HttpMapping {
  method: string;
  path: string;
  pathParams: ParamBinding[];
  queryParams: ParamBinding[];
  querystring?: QuerystringMapping;
  /** Declared OpenAPI `in: header` parameters. */
  headerParams?: ParamBinding[];
  /** Declared OpenAPI `in: cookie` parameters. */
  cookieParams?: ParamBinding[];
  bodyParams: ParamBinding[];
  constants: HttpConstant[];
  requestBody?: RequestBodyMapping;
  /**
   * Send only the bound body fields and the constants, never the agent's raw
   * body. Set when the owner hid or pinned a body field on the MCP page.
   */
  strictBody?: boolean;
}

export interface OperationTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  deprecated: boolean;
  http: HttpMapping;
  /** The owner's published permission. Absent from APIs that predate it. */
  policy?: ToolPolicy;
  /** Whether a call can destroy or overwrite data. */
  destructive?: boolean;
  /** The SDK-derived name, present when the owner renamed the tool. */
  originalName?: string;
  /** The owner's tags for the tool. */
  tags?: string[];
  /** The folder the endpoint sits in, segments joined by " / ". Absent from older APIs. */
  group?: string;
  /** Documented failures from the docs error catalogue. Absent: none documented. */
  errors?: { status: string; issue: string; scenario?: string; field?: string }[];
  /** What a failed call is told, per status or class, from this operation's docs. Absent: nothing. */
  errorHelp?: Record<string, string>;
}

export interface McpToolsResponse {
  tools: OperationTool[];
  baseUrl: string;
  auth: string;
  /** The owner's tool groups, membership resolved to endpoint slugs. Absent: none. */
  groups?: ToolGroup[];
  /**
   * The owner's chained tools, prompts and resources. Separate keys, never
   * entries in `tools`, so a server from before them ignores them.
   */
  chains?: ChainTool[];
  prompts?: PromptTemplate[];
  resources?: ResourceEntry[];
  /** The owner's published listing mode. Absent: automatic. */
  toolMode?: ToolMode;
  /** Visible tools above which automatic searches. Absent: `SEARCH_MODE_THRESHOLD`. */
  searchThreshold?: number;
  /** False when the owner turned outage warnings off. Absent: on. */
  outageWarnings?: false;
  /** The project's error guides per status or class, under each tool's own. Absent: none. */
  errorGuides?: Record<string, string>;
  /**
   * The recent releases of the served tools and what each changed. Absent
   * when the owner turned change notices off, or the API predates them.
   */
  changes?: ToolChanges;
  /**
   * Each operation's documented answers, what practice mode builds its fake
   * responses from. Only sent when practice is asked for and the owner turned
   * it on; absent everywhere else.
   */
  practice?: PracticeData;
  /**
   * Code mode: the languages the owner turned on and each operation's SDK call
   * path. Absent when the owner left it off.
   */
  codeMode?: CodeModeManifest;
  /** The owner's spending and safety limits, and whether writes are audited. Absent: none. */
  limits?: ToolLimits;
}

// Short-lived per-project cache so a ListTools→CallTool exchange only fetches
// once; config changes still surface within the TTL.
const toolCache = new Map<string, { at: number; data: McpToolsResponse }>();
const TOOL_TTL_MS = 30_000;
// Capped as well, since the project id varies per session over SSE.
const TOOL_CACHE_MAX = 64;

export async function fetchOperationTools(
  apiUrl: string,
  projectId: string,
  options: { practice?: boolean } = {},
): Promise<McpToolsResponse> {
  const key = options.practice === true ? `${projectId}#practice` : projectId;
  const cached = toolCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < TOOL_TTL_MS) return cached.data;
  const data = await apiFetch<McpToolsResponse>(
    `${apiUrl}/public/mcp/${encodeURIComponent(projectId)}/tools${options.practice === true ? "?practice=1" : ""}`,
  );
  if (toolCache.size >= TOOL_CACHE_MAX) {
    const oldest = toolCache.keys().next();
    if (oldest.done !== true) toolCache.delete(oldest.value);
  }
  toolCache.set(key, { at: Date.now(), data });
  return data;
}

/** Credentials for the target API come from the end-user's env, keyed by scheme. */
function authHeaders(auth: string, env: EnvSource): Record<string, string> {
  const token = readEnv(env, "API_TOKEN") ?? "";
  const apiKey = readEnv(env, "API_KEY") ?? "";
  switch (auth) {
    case "bearer":
    case "oauth2":
      return token !== "" ? { Authorization: `Bearer ${token}` } : {};
    case "apiKey": {
      const header = readEnv(env, "API_KEY_HEADER") ?? "X-API-Key";
      return apiKey !== "" ? { [header]: apiKey } : {};
    }
    case "basic": {
      const user = readEnv(env, "API_USERNAME") ?? "";
      const pass = readEnv(env, "API_PASSWORD") ?? "";
      if (user !== "" || pass !== "") {
        return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
      }
      return token !== "" ? { Authorization: `Basic ${token}` } : {};
    }
    default:
      return {};
  }
}

function fillPath(http: HttpMapping, args: Record<string, unknown>): string {
  let path = http.path;
  for (const p of http.pathParams) {
    path = path.replace(`{${p.wireName}}`, encodeURIComponent(String(args[p.name] ?? "")));
  }
  for (const c of http.constants) {
    if (c.location === "path") path = path.replace(`{${c.wireName}}`, encodeURIComponent(String(c.value)));
  }
  return path;
}

const OPERATION_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;

/** Reads at most `limit` bytes of a response body and drops the rest. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return truncated ? `${text}\n(truncated at ${limit} bytes)` : text;
}

/**
 * Builds the request URL and refuses anything that leaves the base URL's origin.
 * `path` comes from the stored studio config, and a leading `@` or `//` would
 * re-point it at another host with the caller's credentials attached.
 */
export function resolveOperationUrl(baseUrl: string, path: string, qs: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`Refusing to call the API: unsupported base URL scheme ${base.protocol}`);
  }
  const assembled = new URL(`${baseUrl}${path}${qs !== "" ? `?${qs}` : ""}`);
  if (
    assembled.origin !== base.origin ||
    assembled.username !== "" ||
    assembled.password !== ""
  ) {
    throw new Error(
      `Refusing to call the API: the operation path leaves the configured base URL (${base.origin}).`,
    );
  }
  return assembled;
}

/** One operation call's outcome. `ok` is false for anything the agent must not read as success. */
export interface OperationResult {
  ok: boolean;
  text: string;
  /** Set when the request was built but deliberately not sent. */
  held?: "declined" | "blocked" | "dry_run" | "limited";
  /** Set when the arguments failed the schema check, so no request was built. */
  invalidArgs?: true;
  /**
   * Set when a request was sent and failed: the status it got, or null when no
   * answer came (timeout, connection refused). What the outage check reads.
   */
  failedStatus?: number | null;
  /** For a chained tool: the step whose request failed. */
  failedStep?: OperationTool;
  /** Set when an answer came back failed: what the error guide reads. */
  failure?: FailedAnswer;
  /** Set when an answer came back: its status and body, for a code mode script to read as data. */
  response?: { status: number; body: string };
}

/** A failed answer as the error guide reads it: the body and the headers that matter. */
export interface FailedAnswer {
  status: number;
  body: string;
  /** The `Retry-After` header, as sent. */
  retryAfter?: string;
}

/** The failed answer the error guide reads, from a sent response. */
export function failedAnswer(response: SentResponse): FailedAnswer {
  return {
    status: response.status,
    body: response.text,
    ...(response.retryAfter !== undefined ? { retryAfter: response.retryAfter } : {}),
  };
}

/** A fully built API call, shown to the user for approval or returned by a dry run. */
export interface PendingRequest {
  method: string;
  url: string;
  /** A short, readable rendering of the body, or undefined for none. */
  body?: string;
}

/**
 * Runs between building a request and sending it. Returns null to send it, or
 * the result to hand the agent instead.
 */
export type SendGate = (request: PendingRequest) => Promise<OperationResult | null>;

/** Longest body excerpt shown in an approval prompt or a dry run. */
const BODY_PREVIEW_CHARS = 600;

export function previewBody(body: SerializedRequestBody["body"]): string | undefined {
  if (body === undefined) return undefined;
  let text: string;
  if (typeof body === "string") text = body;
  else if (body instanceof URLSearchParams) text = body.toString();
  else if (body instanceof FormData) {
    text = `multipart form: ${[...new Set([...body.keys()])].join(", ")}`;
  } else text = "binary body";
  return text.length > BODY_PREVIEW_CHARS ? `${text.slice(0, BODY_PREVIEW_CHARS)}…` : text;
}

export function describeRequest(request: PendingRequest): string {
  return `${request.method} ${request.url}${request.body !== undefined ? `\n\n${request.body}` : ""}`;
}

/** A JSON Schema node, narrowed enough to read `required` off a tool input. */
interface SchemaNode {
  required?: unknown;
  properties?: Record<string, SchemaNode | undefined>;
}

function requiredKeys(node: SchemaNode | undefined): string[] {
  const raw = node?.required;
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}

/**
 * Required inputs the caller omitted, as dotted paths (`body.accessToken`).
 *
 * Without this a missing path param silently became an empty segment and the
 * API answered 404, while a missing body field was simply dropped. Both of
 * which read to the agent as "the endpoint is broken" rather than "you left out
 * an argument", so it retried the same malformed call.
 */
export function missingRequired(
  schema: OperationTool["inputSchema"] | undefined,
  args: Record<string, unknown>,
): string[] {
  const root = schema as SchemaNode | undefined;
  if (root === undefined) return [];
  const absent = (v: unknown): boolean => v === undefined || v === null || v === "";

  const missing = requiredKeys(root).filter((key) => absent(args[key]));

  // An optional root body may contain required children. Those children are
  // required only once a caller supplies the root: validating them against an
  // absent body made optional request bodies impossible to omit.
  const bodyValue = args["body"];
  if (isRecord(bodyValue)) {
    for (const key of requiredKeys(root.properties?.["body"])) {
      if (absent(bodyValue[key])) missing.push(`body.${key}`);
    }
  }
  return missing;
}

/**
 * The JSON request body for one operation call, or `undefined` for a method
 * that carries none.
 *
 * A body-bearing method always gets a body, even an empty one. Omitting it while
 * announcing `Content-Type: application/json` does not read as "no payload" to a
 * strict API; it reads as an unparseable one, and the request fails on the body
 * before the route is considered. `{}` is the empty payload.
 */
export function buildRequestBody(
  http: HttpMapping,
  args: Record<string, unknown>,
  method: string,
): string | undefined {
  const request = serializeRequestBody(http, args, method);
  return typeof request.body === "string" ? request.body : undefined;
}

export interface SerializedRequestBody {
  body?: Exclude<RequestInit["body"], null>;
  /** Deliberately absent for multipart: fetch owns its boundary. */
  contentType?: string;
}

const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationBodyValue(http: HttpMapping, args: Record<string, unknown>): unknown {
  const supplied = args["body"];
  // Existing metadata exposes object fields separately. New metadata also carries
  // a root schema: retain direct root arrays, text, and binary descriptors.
  const strict = http.strictBody === true;
  if (!strict && http.bodyParams.length === 0 && supplied !== undefined && !isRecord(supplied)) return supplied;
  const source = isRecord(supplied) ? supplied : {};
  // A root object with no editable bindings still has to retain its supplied
  // fields so body constants can be applied. Root scalar/array values returned
  // above stay untouched.
  // A strict body never forwards it: the owner hid fields the agent may still
  // try to send.
  const value: Record<string, unknown> = http.bodyParams.length === 0 && !strict ? { ...source } : {};
  for (const binding of http.bodyParams) {
    if (source[binding.name] !== undefined) value[binding.wireName] = source[binding.name];
  }
  for (const constant of http.constants) {
    if (constant.location === "body") value[constant.wireName] = constant.value;
  }
  return value;
}

function isJsonMediaType(contentType: string): boolean {
  const media = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

function isBase64(value: string): boolean {
  // Do not let Buffer's permissive decoder turn an arbitrary string into bytes.
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

interface InlineFile {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Files are inline, bounded base64 only. Paths and URLs are intentionally not
 * supported: an MCP caller must never cause this process to read local files or
 * fetch an arbitrary remote URL.
 */
function parseInlineFile(value: unknown): InlineFile | undefined {
  if (!isRecord(value) || typeof value["filename"] !== "string" || typeof value["content"] !== "string") {
    return undefined;
  }
  const filename = value["filename"];
  const content = value["content"];
  const contentType = typeof value["contentType"] === "string" ? value["contentType"] : "application/octet-stream";
  // Check encoded size before regex/Buffer allocation. Base64 expands 4:3.
  if (content.length > Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4) {
    throw new Error(`Inline file exceeds ${MAX_INLINE_FILE_BYTES} byte limit.`);
  }
  if (
    filename.length === 0 || filename.length > 255 || /[\\/\0\r\n]/.test(filename) ||
    contentType.length === 0 || contentType.length > 255 || /[\r\n]/.test(contentType) ||
    !isBase64(content)
  ) {
    throw new Error("Invalid inline file descriptor. Use base64 content, a safe filename, and a valid contentType.");
  }
  const bytes = Buffer.from(content, "base64");
  if (bytes.byteLength > MAX_INLINE_FILE_BYTES) {
    throw new Error(`Inline file exceeds ${MAX_INLINE_FILE_BYTES} byte limit.`);
  }
  return { filename, bytes, contentType };
}

function appendBracketed(
  append: (key: string, value: string, file?: InlineFile) => void,
  key: string,
  value: unknown,
  bytes: { total: number },
  allowInlineFile = false,
): void {
  const file = allowInlineFile ? parseInlineFile(value) : undefined;
  if (file !== undefined) {
    bytes.total += file.bytes.byteLength;
    if (bytes.total > MAX_MULTIPART_BYTES) throw new Error(`Multipart body exceeds ${MAX_MULTIPART_BYTES} byte limit.`);
    append(key, "", file);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      // Indexed object members preserve pairing in a repeated object array.
      appendBracketed(append, isRecord(item) ? `${key}[${index}]` : `${key}[]`, item, bytes, allowInlineFile);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      appendBracketed(append, `${key}[${nestedKey}]`, nestedValue, bytes, allowInlineFile);
    }
    return;
  }
  if (value !== undefined && value !== null) {
    const text = String(value);
    bytes.total += Buffer.byteLength(text);
    if (bytes.total > MAX_MULTIPART_BYTES) throw new Error(`Multipart body exceeds ${MAX_MULTIPART_BYTES} byte limit.`);
    append(key, text);
  }
}

type FormEncoding = NonNullable<RequestBodyMapping["encoding"]>[string];

/**
 * Serialize the OpenAPI `application/x-www-form-urlencoded` subset that this
 * MCP JSON boundary can express without guessing. Explicit encoding changes
 * the wire contract, so it must never quietly fall back to bracket notation.
 */
function appendUrlEncodedField(
  form: URLSearchParams,
  key: string,
  value: unknown,
  encoding: FormEncoding,
  bytes: { total: number },
): void {
  if (encoding.headers !== undefined || encoding.contentType !== undefined) {
    throw new Error(`Unsupported explicit form encoding for ${key}; form part headers/contentType require an upstream client.`);
  }
  const style = encoding.style ?? "form";
  if (style === "deepObject") {
    // Stripe and other providers explicitly use deepObject for form fields.
    // Its wire format is the bracket notation handled by this bounded helper.
    if (encoding.explode !== true) {
      throw new Error(`Unsupported deepObject encoding for ${key}; deepObject requires explode:true.`);
    }
    appendBracketed((name, fieldValue, file) => {
      if (file !== undefined) throw new Error("Inline file descriptor requires multipart/form-data.");
      form.append(name, fieldValue);
    }, key, value, bytes);
    return;
  }
  if (style !== "form") {
    throw new Error(`Unsupported form encoding style ${style} for ${key}; use form style or configure the upstream client directly.`);
  }
  const explode = encoding.explode ?? true;
  if (Array.isArray(value)) {
    if (value.some((item) => isRecord(item) || Array.isArray(item))) {
      throw new Error(`Unsupported nested form value for ${key}; configure the upstream client directly.`);
    }
    if (explode) {
      for (const item of value) form.append(key, String(item));
    } else {
      form.append(key, value.map((item) => String(item)).join(","));
    }
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.some(([, item]) => isRecord(item) || Array.isArray(item) || parseInlineFile(item) !== undefined)) {
      throw new Error(`Unsupported nested form object for ${key}; configure the upstream client directly.`);
    }
    if (explode) {
      for (const [name, item] of entries) form.append(name, String(item));
    } else {
      form.append(key, entries.flatMap(([name, item]) => [name, String(item)]).join(","));
    }
    return;
  }
  if (value !== undefined && value !== null) form.append(key, String(value));
}

function isBinarySchema(value: unknown): boolean {
  return isRecord(value) && value["format"] === "binary";
}

function multipartFieldSchema(http: HttpMapping, wireName: string): unknown {
  const properties = http.requestBody?.schema?.["properties"];
  return (isRecord(properties) ? properties[wireName] : undefined)
    ?? http.bodyParams.find((item) => item.wireName === wireName)?.schema;
}

function hasBinarySchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (isBinarySchema(schema)) return true;
  if (hasBinarySchema(schema["items"])) return true;
  return isRecord(schema["properties"]) && Object.values(schema["properties"]).some(hasBinarySchema);
}

/** Multipart files are recognized only where the documented wire schema declares them. */
function appendMultipartField(
  form: FormData, key: string, value: unknown, schema: unknown,
  partContentType: string | undefined, bytes: { total: number },
): void {
  const count = (size: number): void => {
    bytes.total += size;
    if (bytes.total > MAX_MULTIPART_BYTES) throw new Error(`Multipart body exceeds ${MAX_MULTIPART_BYTES} byte limit.`);
  };
  if (isBinarySchema(schema)) {
    const file = parseInlineFile(value);
    if (file === undefined) throw new Error(`Multipart file ${key} requires an inline file descriptor.`);
    count(file.bytes.byteLength);
    form.append(key, new Blob([file.bytes], { type: partContentType ?? file.contentType }), file.filename);
    return;
  }
  if (partContentType !== undefined && isJsonMediaType(partContentType)) {
    const text = JSON.stringify(value);
    if (text !== undefined) { count(Buffer.byteLength(text)); form.append(key, new Blob([text], { type: partContentType })); }
    return;
  }
  if (Array.isArray(value)) {
    // Multipart arrays repeat the documented wire key, including existing [] spelling.
    for (const item of value) appendMultipartField(form, key, item, isRecord(schema) ? schema["items"] : undefined, partContentType, bytes);
    return;
  }
  if (isRecord(value)) {
    if (hasBinarySchema(schema)) {
      const properties = isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
      for (const [name, item] of Object.entries(value)) {
        appendMultipartField(form, `${key}[${name}]`, item, properties[name], partContentType, bytes);
      }
      return;
    }
    if (partContentType !== undefined) throw new Error(`Multipart object ${key} requires a JSON part content type.`);
    const text = JSON.stringify(value);
    count(Buffer.byteLength(text));
    form.append(key, new Blob([text], { type: "application/json" }));
    return;
  }
  if (value !== undefined && value !== null) {
    const text = String(value);
    count(Buffer.byteLength(text));
    form.append(key, partContentType === undefined ? text : new Blob([text], { type: partContentType }));
  }
}

/** Serialize operation body from its OpenAPI media type without filesystem or URL inputs. */
export function serializeRequestBody(
  http: HttpMapping,
  args: Record<string, unknown>,
  method: string,
): SerializedRequestBody {
  if (method === "GET" || method === "HEAD") return {};

  // New metadata distinguishes an optional absent body from legacy projections.
  // Keep legacy `undefined` on the historical JSON `{}` behavior.
  if (http.requestBody?.required === false && args["body"] === undefined) return {};

  const mediaType = http.requestBody?.contentType?.split(";", 1)[0]?.trim().toLowerCase() || "application/json";
  const value = operationBodyValue(http, args);
  if (isJsonMediaType(mediaType)) {
    return { body: JSON.stringify(value), contentType: http.requestBody?.contentType ?? "application/json" };
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams();
    const bytes = { total: 0 };
    if (isRecord(value)) {
      for (const [key, field] of Object.entries(value)) {
        const encoding = http.requestBody?.encoding?.[key];
        if (encoding !== undefined) {
          appendUrlEncodedField(form, key, field, encoding, bytes);
          continue;
        }
        appendBracketed((name, fieldValue, file) => {
          if (file !== undefined) throw new Error("Inline file descriptor requires multipart/form-data.");
          form.append(name, fieldValue);
        }, key, field, bytes);
      }
    }
    return { body: form.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  if (mediaType === "multipart/form-data") {
    for (const [field, encoding] of Object.entries(http.requestBody?.encoding ?? {})) {
      if (encoding.style !== undefined || encoding.explode !== undefined || encoding.headers !== undefined) {
        throw new Error(`Unsupported explicit multipart encoding for ${field}; use default form encoding or configure the upstream client directly.`);
      }
    }
    const form = new FormData();
    const bytes = { total: 0 };
    if (isRecord(value)) {
      for (const [key, field] of Object.entries(value)) {
        const configuredType = http.requestBody?.encoding?.[key]?.["contentType"];
        const partContentType = typeof configuredType === "string" ? configuredType : undefined;
        appendMultipartField(form, key, field, multipartFieldSchema(http, key), partContentType, bytes);
      }
    }
    return { body: form };
  }
  if (mediaType.startsWith("text/")) {
    if (typeof value !== "string") throw new Error(`${mediaType} requires a string body.`);
    return { body: value, contentType: http.requestBody?.contentType ?? mediaType };
  }

  // Binary media must use the same explicit descriptor as multipart. It gives
  // MCP JSON callers a bounded representation and prevents ambient file reads.
  const file = parseInlineFile(value);
  if (file === undefined) {
    throw new Error(`${mediaType} requires an inline file descriptor: { filename, content, contentType? }.`);
  }
  return { body: file.bytes, contentType: http.requestBody?.contentType ?? mediaType };
}

type ParameterLocation = "query" | "header" | "cookie";

function serializeParameter(value: unknown, binding: ParamBinding, location: ParameterLocation): string[] {
  const style = binding.style ?? (location === "header" ? "simple" : "form");
  const explode = binding.explode ?? (style === "form");
  if (Array.isArray(value)) {
    const delimiter = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
    return explode ? value.map((item) => String(item)) : [value.map((item) => String(item)).join(delimiter)];
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => [key, String(item)] as const);
    if (style === "deepObject") {
      // Caller builds key names for deep-object query serialization separately.
      return [JSON.stringify(Object.fromEntries(entries))];
    }
    return [explode
      ? entries.map(([key, item]) => `${key}=${item}`).join(",")
      : entries.flat().join(",")];
  }
  return [String(value)];
}

interface QueryPair { name: string; value: string; allowReserved: boolean }

function querystringInputName(mapping: QuerystringMapping): string {
  return mapping.inputName ?? mapping.name;
}

/** Shared, vendored serializer keeps the published package self-contained. */
export function serializeWholeQuery(value: unknown, content: Record<string, unknown>): string {
  return encodeQuerystring(value, content);
}

function wholeQuery(http: HttpMapping, args: Record<string, unknown>): string | undefined {
  const mapping = http.querystring;
  if (mapping === undefined) return undefined;
  if (http.queryParams.length > 0 || http.constants.some((constant) => constant.location === "query")) {
    throw new Error("An operation cannot combine an OpenAPI 3.2 whole query with named query parameters or query constants.");
  }
  const value = args[querystringInputName(mapping)];
  if (value === undefined) return undefined;
  return serializeWholeQuery(value, mapping.content);
}

function appendQueryParameter(query: QueryPair[], binding: ParamBinding, value: unknown): void {
  const style = binding.style ?? "form";
  const explode = binding.explode ?? (style === "form");
  const allowReserved = binding.allowReserved === true;
  if (style === "deepObject" && isRecord(value)) {
    for (const [key, item] of Object.entries(value)) query.push({ name: `${binding.wireName}[${key}]`, value: String(item), allowReserved });
    return;
  }
  if (style === "form" && explode && isRecord(value)) {
    for (const [key, item] of Object.entries(value)) query.push({ name: key, value: String(item), allowReserved });
    return;
  }
  for (const serialized of serializeParameter(value, binding, "query")) query.push({ name: binding.wireName, value: serialized, allowReserved });
}

function encodeQueryValue(value: string, allowReserved: boolean): string {
  const encoded = encodeURIComponent(value);
  // `#` cannot remain literal: it would terminate the URL query. Other RFC3986
  // reserved characters are safe inside a query value and OpenAPI allows them.
  return allowReserved ? encoded.replace(/%3A|%2F|%3F|%40|%21|%24|%26|%27|%28|%29|%2A|%2B|%2C|%3B|%3D/gi, (part) => decodeURIComponent(part)) : encoded;
}

function operationHeaders(http: HttpMapping, args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const binding of http.headerParams ?? []) {
    const value = args[binding.name];
    if (value !== undefined && value !== null && value !== "") {
      headers[binding.wireName] = serializeParameter(value, binding, "header").join(",");
    }
  }
  const cookies: string[] = [];
  for (const binding of http.cookieParams ?? []) {
    const value = args[binding.name];
    if (value !== undefined && value !== null && value !== "") {
      const style = binding.style ?? "form";
      const explode = binding.explode ?? (style === "form");
      if (style === "form" && explode && isRecord(value)) {
        for (const [name, item] of Object.entries(value)) {
          cookies.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`);
        }
        continue;
      }
      for (const serialized of serializeParameter(value, binding, "cookie")) {
        cookies.push(`${encodeURIComponent(binding.wireName)}=${encodeURIComponent(serialized)}`);
      }
    }
  }
  for (const constant of http.constants) {
    if (constant.location === "header") headers[constant.wireName] = String(constant.value);
    if (constant.location === "cookie") cookies.push(`${encodeURIComponent(constant.wireName)}=${encodeURIComponent(String(constant.value))}`);
  }
  if (cookies.length > 0) headers["Cookie"] = cookies.join("; ");
  return headers;
}

function isSlackSemanticError(url: URL, responseText: string): boolean {
  // Slack uses 200 with { ok:false, error } as its documented application
  // failure envelope. Scope detection to Slack's own origin; another provider's
  // unrelated `ok:false` payload remains valid response data.
  const host = url.hostname.toLowerCase();
  if (host !== "slack.com" && !host.endsWith(".slack.com")) return false;
  try {
    const payload = JSON.parse(responseText) as { ok?: unknown; error?: unknown };
    return payload.ok === false && typeof payload.error === "string" && payload.error !== "";
  } catch {
    return false;
  }
}

const FETCH_NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
const FETCH_FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

/** Reject methods Fetch forbids or would silently normalize on the wire. */
function fetchMethodError(method: string): string | undefined {
  if (!isHttpMethodToken(method)) {
    return `Invalid HTTP method token ${JSON.stringify(method)}.`;
  }
  const uppercase = method.toUpperCase();
  if (FETCH_FORBIDDEN_METHODS.has(uppercase)) {
    return `Cannot execute HTTP method ${JSON.stringify(method)}: Fetch forbids ${uppercase}.`;
  }
  if (FETCH_NORMALIZED_METHODS.has(uppercase) && method !== uppercase) {
    return `Cannot execute custom HTTP method ${JSON.stringify(method)}: Fetch would normalize it to ${uppercase}.`;
  }
  return undefined;
}

/** A request built for one operation call, complete but not sent. */
export interface BuiltRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: SerializedRequestBody["body"];
  /** What an approval prompt or a dry run shows (no headers: they carry credentials). */
  pending: PendingRequest;
}

/** What came back from the API, before it is turned into text for an agent. */
export interface SentResponse {
  /** 2xx, and not an API that reports failure inside a 200 (Slack). */
  ok: boolean;
  status: number;
  statusText: string;
  /** The body as text, capped. */
  text: string;
  /** The `Retry-After` header, when the API sent one. */
  retryAfter?: string;
}

/** The base URL calls go to: the end user's override, else the published one. */
export function effectiveBaseUrl(meta: Pick<McpToolsResponse, "baseUrl">, env: EnvSource = processEnv()): string {
  return (readEnv(env, "API_BASE_URL") ?? meta.baseUrl ?? "").replace(/\/+$/, "");
}

/**
 * Builds the real API call for one operation tool without sending it: checks
 * required arguments, serializes path, query, headers and body, and adds the
 * end user's credentials. The chained-tool engine builds every step through
 * this, so a step sends exactly what a direct call would.
 */
export function buildOperationRequest(
  tool: OperationTool,
  meta: McpToolsResponse,
  args: Record<string, unknown>,
  env: EnvSource = processEnv(),
): { ok: true; request: BuiltRequest } | { ok: false; text: string; invalidArgs?: true } {
  const baseUrl = effectiveBaseUrl(meta, env);
  if (baseUrl === "") {
    return {
      ok: false,
      // The SDK Studio hint is only true of the Octri-hosted tool list; a
      // branded build bakes its base URL in, so only the variable is named.
      text: `Error: no API base URL configured. Set ${envName(env, "API_BASE_URL")}${
        env.prefix === DEFAULT_ENV_PREFIX ? ", or set a Base URL in the SDK Studio (Output tab)" : ""
      }.`,
    };
  }

  const wholeQueryName = tool.http.querystring === undefined ? undefined : querystringInputName(tool.http.querystring);
  const absent = missingRequired(tool.inputSchema, args).filter((key) =>
    key !== wholeQueryName || !Object.hasOwn(args, key) || args[key] === undefined,
  );
  if (absent.length > 0) {
    return {
      ok: false,
      invalidArgs: true,
      text: `Error: ${tool.name} is missing required ${absent.length === 1 ? "argument" : "arguments"}: ${absent.join(", ")}.`,
    };
  }

  const http = tool.http;
  const method = http.method;
  const methodError = fetchMethodError(method);
  if (methodError !== undefined) return { ok: false, text: `Error: ${methodError}` };
  const path = fillPath(http, args);

  let qs: string;
  try {
    const completeQuery = wholeQuery(http, args);
    if (completeQuery !== undefined) {
      qs = completeQuery;
    } else {
      const query: QueryPair[] = [];
      for (const q of http.queryParams) {
        const v = args[q.name];
        if (v !== undefined && v !== null && v !== "") appendQueryParameter(query, q, v);
      }
      for (const c of http.constants) {
        if (c.location === "query") query.push({ name: c.wireName, value: String(c.value), allowReserved: false });
      }
      qs = query.map((pair) => `${encodeURIComponent(pair.name)}=${encodeQueryValue(pair.value, pair.allowReserved)}`).join("&");
    }
  } catch (err) {
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }

  let requestBody: SerializedRequestBody;
  try {
    requestBody = serializeRequestBody(http, args, method);
  } catch (err) {
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }

  let url: URL;
  try {
    url = resolveOperationUrl(baseUrl, path, qs);
  } catch (err) {
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const headers = new Headers(operationHeaders(http, args));
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (requestBody.contentType !== undefined) headers.set("Content-Type", requestBody.contentType);
  // Headers normalise names case-insensitively, so an operation parameter cannot
  // smuggle a second Authorization/Content-Type around the credential policy.
  for (const [name, value] of Object.entries(authHeaders(meta.auth, env))) headers.set(name, value);

  const preview = previewBody(requestBody.body);
  return {
    ok: true,
    request: {
      method,
      url,
      headers,
      body: requestBody.body,
      pending: { method, url: url.toString(), ...(preview !== undefined ? { body: preview } : {}) },
    },
  };
}

/** Sends a built request and reads the response, capped. Never waits past the per-call limit. */
export async function sendOperationRequest(
  request: BuiltRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = OPERATION_TIMEOUT_MS,
): Promise<SentResponse> {
  const res = await fetchImpl(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, OPERATION_TIMEOUT_MS))),
  });
  const text = await readCapped(res, MAX_RESPONSE_BYTES).catch(() => "");
  const retryAfter = res.headers.get("retry-after")?.trim();
  return {
    ok: res.ok && !isSlackSemanticError(request.url, text),
    status: res.status,
    statusText: res.statusText,
    text,
    ...(retryAfter !== undefined && retryAfter !== "" ? { retryAfter } : {}),
  };
}

/** The text an agent reads for one sent request: the call, its status, the body. */
export function formatResponse(request: Pick<BuiltRequest, "method" | "url">, response: SentResponse): string {
  const status = `${response.status}${response.statusText !== "" ? ` ${response.statusText}` : ""}`;
  return `${request.method} ${request.url} → ${status}\n\n${response.text !== "" ? response.text : "(empty response body)"}`;
}

/** Build + perform the real API call for one operation tool, return a text result. */
export async function executeOperation(
  tool: OperationTool,
  meta: McpToolsResponse,
  args: Record<string, unknown>,
  gate?: SendGate,
  env: EnvSource = processEnv(),
  fetchImpl: typeof fetch = fetch,
): Promise<OperationResult> {
  const built = buildOperationRequest(tool, meta, args, env);
  if (!built.ok) return built;

  // Last stop before the wire: the request is complete, so an approval prompt
  // or a dry run shows exactly what would be sent (headers aside: they carry
  // the user's credentials).
  if (gate !== undefined) {
    const held = await gate(built.request.pending);
    if (held !== null) return held;
  }

  // Return the raw response (even on 4xx/5xx) so the agent can read the error,
  // but report the transport status honestly: a 4xx surfaced as a successful
  // tool result is indistinguishable from real data to a model.
  let response: SentResponse;
  try {
    response = await sendOperationRequest(built.request, fetchImpl);
  } catch (err) {
    return { ok: false, text: `Error: ${err instanceof Error ? err.message : String(err)}`, failedStatus: null };
  }
  return {
    ok: response.ok,
    text: formatResponse(built.request, response),
    response: { status: response.status, body: response.text },
    ...(response.ok ? {} : { failedStatus: response.status, failure: failedAnswer(response) }),
  };
}
