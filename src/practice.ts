// ─── Practice mode ─────────────────────────────────────────────────────────────
//
// Fake responses built from the API's own documentation, so an agent or a demo
// can run a whole workflow with no credential and no upstream at all. It plugs
// in as the server's `fetch`: requests are still built and checked by the real
// code path, chains run step by step, and a simulated failure is a real failed
// Response, so the error guide answers it unchanged.
//
// State lives in one PracticeSession per server, and a server is made per
// session on every host (a hosted session, a Worker Durable Object, one stdio
// process), so two sessions never see each other's records.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { ChainTool } from "./chains.js";
import type { McpToolsResponse, OperationTool } from "./operations.js";
import { generateField, generateFromSchema, schemaType, seedFrom, type JsonSchema } from "./practice-schema.js";

/** One operation's documented answers, what practice mode builds its responses from. */
export interface PracticeShape {
  /** The documented success status: the lowest 2xx. */
  status: number;
  /** The spec's example for it, when there is one. */
  example?: unknown;
  /** Its schema, trimmed for size, when there is one. */
  schema?: JsonSchema;
  /** Documented failures, for simulated errors. */
  errors?: { status: number; example?: unknown }[];
}

/** Practice shapes per endpoint slug. */
export type PracticeData = Record<string, PracticeShape>;

/** The host every practice request is built against. Reserved, so nothing can ever answer it. */
export const PRACTICE_BASE_URL = "https://practice.octri.invalid";

/** The practice-only tool that arms failures and resets the session. */
export const PRACTICE_CONTROL = "practice_control";

/** The first line of every practice result. */
export const PRACTICE_HEADER =
  "PRACTICE MODE: fake response built from the API's documentation. Nothing was sent to the API.";

/** What every tool description starts with in practice mode. */
export const PRACTICE_TOOL_PREFIX = "[Practice mode: fake responses] ";

/** The `_meta` key every practice result and tool carries. */
export const PRACTICE_META_KEY = "dev.octri/practice";

/** Told to the client at the handshake. */
export const PRACTICE_INSTRUCTIONS =
  "This server is in practice mode. Every API tool answers with fake data built from the API's documentation, " +
  "and nothing is sent to the real API. Records you create are kept for this session only. Do not treat any " +
  `result as real. ${PRACTICE_CONTROL} can simulate an error on a tool's next call, or reset the session.`;

/** Why a practice call has nothing to answer from. */
export const PRACTICE_OFF_TEXT =
  "Practice mode is off for this API: its owner has not turned it on, so there is nothing to answer from. " +
  "Nothing was sent. Ask the owner to turn on practice mode, or connect with real credentials.";

export const PRACTICE_LIMITS = {
  /** Records one session keeps, oldest dropped first. */
  records: 200,
  /** Records one collection keeps. */
  perCollection: 50,
  /** A record larger than this, serialized, is answered but not kept. */
  recordChars: 16_000,
  /** Calls one session may make before it must start over. Hosts may lower it. */
  calls: 300,
  /** Most items a list answers, whatever `limit` asks. */
  listItems: 10,
} as const;

/** The query parameters that size a list. */
const LIMIT_PARAMS = ["limit", "per_page", "perPage", "page_size", "pageSize", "max_results", "maxResults", "count", "size", "top"];
/** Where a list response usually keeps its items. */
const LIST_KEYS = ["data", "items", "results", "records", "entries", "list", "values", "nodes", "rows"];

interface PracticeRecord {
  collection: string;
  id: string;
  value: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

/** Sorted keys, so `{a,b}` and `{b,a}` seed the same answer. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ── Routing ───────────────────────────────────────────────────────────────────

export interface PracticeRoute {
  slug: string;
  method: string;
  path: string;
  /** The template's path parameter names, in order. */
  params: string[];
  /** True when the template ends at a path parameter: an item route. */
  item: boolean;
  re: RegExp;
  literal: boolean;
}

function templateRegex(path: string): RegExp {
  const escaped = path
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? "([^/]+)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${escaped}/?$`);
}

/**
 * Every operation a manifest can send, its chains' steps included, literal
 * paths first so they win over templated ones, as on a real router.
 */
export function practiceRoutes(manifest: Pick<McpToolsResponse, "tools" | "chains">): PracticeRoute[] {
  const seen = new Map<string, PracticeRoute>();
  const add = (t: { slug: string; http: { method: string; path: string } }) => {
    if (seen.has(t.slug)) return;
    const path = t.http.path;
    seen.set(t.slug, {
      slug: t.slug,
      method: t.http.method.toUpperCase(),
      path,
      params: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
      item: /\{[^}]+\}\/?$/.test(path),
      re: templateRegex(path),
      literal: !path.includes("{"),
    });
  };
  for (const tool of manifest.tools) add(tool);
  for (const chain of manifest.chains ?? []) for (const step of chain.steps) add(step.tool);
  return [...seen.values()].sort((a, b) => Number(b.literal) - Number(a.literal));
}

export function matchPracticeRoute(
  routes: readonly PracticeRoute[],
  method: string,
  pathname: string,
): { route: PracticeRoute; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (m === null) continue;
    const params: Record<string, string> = {};
    route.params.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { route, params };
  }
  return undefined;
}

// ── Echo ──────────────────────────────────────────────────────────────────────

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
}

/** Whether a request value may stand in a response field of this schema. */
function fits(value: unknown, schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  const type = schemaType(schema);
  if (type === undefined) return true;
  const actual = jsonType(value);
  return actual === type || (type === "number" && actual === "integer");
}

function propertiesOf(schema: JsonSchema | undefined): JsonRecord {
  return isRecord(schema?.["properties"]) ? (schema["properties"] as JsonRecord) : {};
}

/**
 * Copies request fields into the response fields of the same name, top level
 * and one level down, when the types agree. A field the response does not have
 * is left out: echoing it would invent a shape the API never documented.
 */
export function echoInto(target: JsonRecord, source: JsonRecord, schema: JsonSchema | undefined, depth = 0): JsonRecord {
  const props = propertiesOf(schema);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const known = Object.hasOwn(target, key) || Object.hasOwn(props, key);
    if (!known || !fits(value, props[key])) continue;
    if (depth === 0 && isRecord(value) && isRecord(target[key])) {
      target[key] = echoInto({ ...(target[key] as JsonRecord) }, value, props[key] as JsonSchema | undefined, depth + 1);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

/** The field that names a record: `id`, else `<thing>Id` / `<thing>_id`, else any `*id` key. */
function idField(record: JsonRecord, params: readonly string[]): string | undefined {
  if (Object.hasOwn(record, "id")) return "id";
  const last = params[params.length - 1];
  if (last !== undefined && Object.hasOwn(record, last)) return last;
  for (const key of ["uuid", "guid", "key", "name"]) if (Object.hasOwn(record, key)) return key;
  return Object.keys(record).find((k) => /(^|_)id$|[a-z]Id$/.test(k));
}

/** A fresh id in the style of the one the example or schema shows. */
function freshId(previous: unknown, schema: unknown, seed: number, ordinal: number): unknown {
  // The schema's own pattern or format is the truest style there is.
  if (isRecord(schema) && (typeof schema["pattern"] === "string" || typeof schema["format"] === "string")) {
    return generateField(schema, "id", seed);
  }
  if (typeof previous === "number" && Number.isInteger(previous)) return previous + ordinal;
  if (typeof previous === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(previous)) return generateField({ type: "string", format: "uuid" }, "id", seed);
    if (/^\d+$/.test(previous)) return String(Number(previous) + ordinal);
    const prefix = /^(.*[_-])[^_-]+$/.exec(previous)?.[1];
    const tail = (seed >>> 0).toString(16).padStart(8, "0") + ordinal.toString(16).padStart(4, "0");
    return `${prefix ?? ""}${tail}`;
  }
  return generateField(isRecord(schema) ? schema : { type: "string" }, "id", seed);
}

// ── The session ───────────────────────────────────────────────────────────────

export interface PracticeAnswer {
  status: number;
  body?: unknown;
}

/** One session's practice state: the records it created and the failures it armed. */
export class PracticeSession {
  readonly seed: string;
  private readonly records = new Map<string, PracticeRecord>();
  private readonly deleted = new Set<string>();
  private readonly armed = new Map<string, { status: number; times: number }>();
  private created = 0;
  calls = 0;
  readonly callLimit: number;

  constructor(options: { seed?: string; callLimit?: number } = {}) {
    this.seed = options.seed ?? "octri-practice";
    this.callLimit = options.callLimit ?? PRACTICE_LIMITS.calls;
  }

  get size(): number {
    return this.records.size;
  }

  reset(): void {
    this.records.clear();
    this.deleted.clear();
    this.armed.clear();
    this.created = 0;
  }

  /** The next `times` calls of this endpoint fail with `status`. */
  arm(slug: string, status: number, times = 1): void {
    this.armed.set(slug, { status, times: Math.max(1, Math.min(Math.trunc(times), 20)) });
  }

  armedFor(slug: string): number | undefined {
    return this.armed.get(slug)?.status;
  }

  private takeArmed(slug: string): number | undefined {
    const entry = this.armed.get(slug);
    if (entry === undefined) return undefined;
    if (--entry.times <= 0) this.armed.delete(slug);
    return entry.status;
  }

  private keyOf(collection: string, id: string) {
    return `${collection}\u0000${id}`;
  }

  private collectionRecords(collection: string): PracticeRecord[] {
    return [...this.records.values()].filter((r) => r.collection === collection);
  }

  private store(record: PracticeRecord): void {
    if (JSON.stringify(record.value).length > PRACTICE_LIMITS.recordChars) return;
    const key = this.keyOf(record.collection, record.id);
    this.records.delete(key);
    this.deleted.delete(key);
    this.records.set(key, record);
    const inCollection = this.collectionRecords(record.collection);
    if (inCollection.length > PRACTICE_LIMITS.perCollection) {
      const oldest = inCollection[0] as PracticeRecord;
      this.records.delete(this.keyOf(oldest.collection, oldest.id));
    }
    while (this.records.size > PRACTICE_LIMITS.records) {
      const oldest = this.records.keys().next();
      if (oldest.done === true) break;
      this.records.delete(oldest.value);
    }
  }

  /**
   * The answer to one request. Collections are the concrete path (an item
   * route's without its last segment), so `/users/1/pets` and `/users/2/pets`
   * hold different records.
   */
  answer(input: {
    route: PracticeRoute;
    params: Record<string, string>;
    shape: PracticeShape | undefined;
    pathname: string;
    query: URLSearchParams;
    body: unknown;
  }): PracticeAnswer {
    const { route, params, shape, pathname, query, body } = input;
    const failing = this.takeArmed(route.slug);
    if (failing !== undefined) return failureAnswer(shape, failing, route);
    if (shape === undefined) {
      return { status: 200, body: { note: "Practice mode: the spec documents no example response for this operation." } };
    }

    const queryObject = Object.fromEntries(query.entries());
    const seed = seedFrom(this.seed, route.slug, route.method, pathname, canonical(queryObject), canonical(body ?? null));
    const base = shape.example !== undefined ? clone(shape.example) : generateFromSchema(shape.schema, seed);
    const status = shape.status;
    const trimmed = pathname.replace(/\/+$/, "");
    const collection = route.item ? trimmed.slice(0, trimmed.lastIndexOf("/")) : trimmed;
    const itemId = route.item ? (params[route.params[route.params.length - 1] as string] ?? "") : undefined;
    const bodyRecord = isRecord(body) ? body : {};
    // Path parameters echo too: `{petId}` into `petId`.
    const echoed = (value: unknown): unknown =>
      isRecord(value) ? echoInto(echoInto(value, params, shape.schema), bodyRecord, shape.schema) : value;

    switch (route.method) {
      case "POST": {
        if (route.item || !isRecord(base)) return { status, body: echoed(base) };
        const record = echoed(base) as JsonRecord;
        const field = idField(record, route.params);
        this.created++;
        if (field !== undefined) {
          record[field] = freshId(record[field], propertiesOf(shape.schema)[field], seedFrom(String(seed), String(this.created)), this.created);
        }
        const id = field !== undefined ? String(record[field]) : `practice-${this.created}`;
        this.store({ collection, id, value: clone(record) });
        return { status, body: record };
      }
      case "GET": {
        if (itemId !== undefined) {
          const key = this.keyOf(collection, itemId);
          const stored = this.records.get(key);
          if (stored !== undefined) return { status, body: clone(stored.value) };
          if (this.deleted.has(key)) return notFound(shape, route, itemId);
          if (!isRecord(base)) return { status, body: base };
          const record = echoed(base) as JsonRecord;
          const field = idField(record, route.params);
          if (field !== undefined && fits(itemId, propertiesOf(shape.schema)[field] ?? { type: jsonType(record[field]) })) {
            record[field] = typeof record[field] === "number" && /^\d+$/.test(itemId) ? Number(itemId) : itemId;
          }
          return { status, body: record };
        }
        return { status, body: this.withRecords(base, collection, queryObject, shape.schema) };
      }
      case "PUT":
      case "PATCH": {
        if (itemId === undefined) return { status, body: echoed(base) };
        const key = this.keyOf(collection, itemId);
        const stored = this.records.get(key);
        if (stored === undefined && this.deleted.has(key)) return notFound(shape, route, itemId);
        const current = stored !== undefined ? clone(stored.value) : isRecord(base) ? (echoed(base) as JsonRecord) : undefined;
        if (current === undefined) return { status, body: base };
        const next = echoInto(current, bodyRecord, shape.schema);
        const field = idField(next, route.params);
        if (field !== undefined && stored === undefined) next[field] = typeof next[field] === "number" && /^\d+$/.test(itemId) ? Number(itemId) : itemId;
        this.store({ collection, id: itemId, value: clone(next) });
        return status === 204 ? { status } : { status, body: next };
      }
      case "DELETE": {
        if (itemId === undefined) return { status, body: base };
        const key = this.keyOf(collection, itemId);
        if (this.deleted.has(key)) return notFound(shape, route, itemId);
        this.records.delete(key);
        this.deleted.add(key);
        if (this.deleted.size > PRACTICE_LIMITS.records) {
          const first = this.deleted.values().next();
          if (first.done !== true) this.deleted.delete(first.value);
        }
        return status === 204 ? { status } : { status, body: echoed(base) };
      }
      default:
        return { status, body: echoed(base) };
    }
  }

  /** A list answer with this session's records in it, newest first, sized by `limit`. */
  private withRecords(base: unknown, collection: string, query: Record<string, string>, schema: JsonSchema | undefined): unknown {
    const stored = this.collectionRecords(collection).map((r) => clone(r.value)).reverse();
    const limitParam = LIMIT_PARAMS.find((p) => query[p] !== undefined && /^\d+$/.test(query[p] as string));
    const limit = Math.min(limitParam !== undefined ? Number(query[limitParam]) : PRACTICE_LIMITS.listItems, PRACTICE_LIMITS.listItems);
    const merge = (items: unknown[]) => {
      // Generated items in the shape of the first, after the session's own.
      const filled = [...stored, ...items];
      if (limitParam !== undefined && items.length > 0) {
        for (let i = 0; filled.length < limit && i < limit; i++) filled.push(clone(items[i % items.length]));
      }
      return filled.slice(0, limit);
    };
    if (Array.isArray(base)) return merge(base);
    if (!isRecord(base)) return base;
    const props = propertiesOf(schema);
    const key =
      LIST_KEYS.find((k) => Array.isArray(base[k])) ??
      Object.keys(base).find((k) => Array.isArray(base[k]) && ((base[k] as unknown[]).every(isRecord) || isRecord(props[k])));
    if (key === undefined) return base;
    return { ...base, [key]: merge(base[key] as unknown[]) };
  }
}

function failureBody(shape: PracticeShape | undefined, status: number): unknown {
  const documented = shape?.errors?.find((e) => e.status === status && e.example !== undefined);
  if (documented !== undefined) return clone(documented.example);
  const messages: Record<number, string> = {
    400: "The request is invalid.",
    401: "Authentication is required.",
    403: "You do not have permission to do this.",
    404: "The resource was not found.",
    409: "The request conflicts with the current state.",
    422: "The request could not be processed.",
    429: "Too many requests. Slow down and retry.",
    500: "Internal server error.",
    502: "Bad gateway.",
    503: "The service is unavailable.",
  };
  return { error: { status, message: messages[status] ?? "The request failed." } };
}

function failureAnswer(shape: PracticeShape | undefined, status: number, _route: PracticeRoute): PracticeAnswer {
  return { status, body: failureBody(shape, status) };
}

function notFound(shape: PracticeShape, route: PracticeRoute, id: string): PracticeAnswer {
  const documented = shape.errors?.find((e) => e.status === 404 && e.example !== undefined);
  if (documented !== undefined) return { status: 404, body: clone(documented.example) };
  const what = route.params[route.params.length - 1] ?? "id";
  return { status: 404, body: { error: { status: 404, message: `No record with ${what} ${id} in this practice session: it was deleted.` } } };
}

const REASONS: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
};

async function readJsonBody(init: RequestInit | undefined): Promise<unknown> {
  const raw = init?.body;
  if (raw === undefined || raw === null) return undefined;
  let text: string | undefined;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof URLSearchParams) return Object.fromEntries(raw.entries());
  else if (raw instanceof FormData) {
    const out: JsonRecord = {};
    for (const [k, v] of raw.entries()) if (typeof v === "string") out[k] = v;
    return out;
  }
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A fetch that answers every request from practice data and this session's
 * records, and never touches a network. A request no operation matches gets a
 * 404, as from a real router. Without practice data, every call is told
 * practice mode is off.
 */
export function practiceFetch(
  manifest: Pick<McpToolsResponse, "tools" | "chains" | "practice">,
  session: PracticeSession,
): typeof fetch {
  const routes = practiceRoutes(manifest);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
        status,
        statusText: REASONS[status] ?? "",
        headers: { "content-type": "application/json" },
      });
    if (url.origin !== PRACTICE_BASE_URL) {
      // Never reached: practice builds every request against the reserved host.
      return json(400, { error: "Practice mode sends nothing to a real host." });
    }
    if (manifest.practice === undefined) return json(403, { error: PRACTICE_OFF_TEXT });
    const matched = matchPracticeRoute(routes, method, url.pathname);
    if (matched === undefined) return json(404, { error: "No operation in this API matches this request." });
    const answer = session.answer({
      route: matched.route,
      params: matched.params,
      shape: manifest.practice[matched.route.slug],
      pathname: url.pathname,
      query: url.searchParams,
      body: await readJsonBody(init),
    });
    return json(answer.status, answer.body);
  };
}

// ── What the agent sees ───────────────────────────────────────────────────────

/** The practice-only control tool. */
export function practiceControlTool(): Tool {
  return {
    name: PRACTICE_CONTROL,
    description:
      `${PRACTICE_TOOL_PREFIX}Controls this practice session. action "simulate_error" makes the next call(s) ` +
      `of a tool fail with the given HTTP status (its documented error when there is one), so you can practice ` +
      `handling failures. action "reset" forgets every record this session created and every armed error.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["simulate_error", "reset"] },
        tool: { type: "string", description: "simulate_error: the tool whose next call fails." },
        status: { type: "integer", minimum: 400, maximum: 599, description: "simulate_error: the HTTP status. Default 500." },
        times: { type: "integer", minimum: 1, maximum: 20, description: "simulate_error: how many calls fail. Default 1." },
      },
      required: ["action"],
    },
    annotations: { title: PRACTICE_CONTROL, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { [PRACTICE_META_KEY]: true },
  };
}

/** The slugs a served name sends to: an operation's own, or every step of a chain. */
function slugsFor(manifest: Pick<McpToolsResponse, "tools" | "chains">, name: string): string[] | undefined {
  const tool: OperationTool | undefined = manifest.tools.find((t) => t.name === name);
  if (tool !== undefined) return [tool.slug];
  const chain: ChainTool | undefined = manifest.chains?.find((c) => c.name === name);
  return chain !== undefined ? [chain.steps[0]?.tool.slug].filter((s): s is string => s !== undefined) : undefined;
}

/** The control tool's answer: text, and whether it is an error. */
export function runPracticeControl(
  manifest: Pick<McpToolsResponse, "tools" | "chains">,
  session: PracticeSession,
  args: Record<string, unknown>,
  allowed: (name: string) => boolean,
): { text: string; isError: boolean } {
  const action = args["action"];
  if (action === "reset") {
    session.reset();
    return { text: "Practice session reset: every record it created and every armed error is gone.", isError: false };
  }
  if (action !== "simulate_error") {
    return { text: `Error: ${PRACTICE_CONTROL} takes action "simulate_error" or "reset".`, isError: true };
  }
  const name = typeof args["tool"] === "string" ? args["tool"].trim() : "";
  const slugs = name !== "" && allowed(name) ? slugsFor(manifest, name) : undefined;
  if (slugs === undefined || slugs.length === 0) {
    return { text: `Error: simulate_error needs the name of one of this server's API tools${name !== "" ? `; ${name} is not one` : ""}.`, isError: true };
  }
  const status = typeof args["status"] === "number" && args["status"] >= 400 && args["status"] <= 599 ? Math.trunc(args["status"]) : 500;
  const times = typeof args["times"] === "number" ? args["times"] : 1;
  for (const slug of slugs) session.arm(slug, status, times);
  const count = Math.max(1, Math.min(Math.trunc(times), 20));
  return {
    text: `Armed: the next ${count === 1 ? "call" : `${count} calls`} of ${name} will fail with HTTP ${status}. Nothing real is affected.`,
    isError: false,
  };
}

/** A practice copy of a manifest: every request goes to the reserved host. */
export function practiceManifest<T extends Pick<McpToolsResponse, "baseUrl">>(manifest: T): T {
  return { ...manifest, baseUrl: PRACTICE_BASE_URL };
}

/** Whether practice mode is asked for in an env value. */
export function practiceAsked(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
