import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import {
  LANGUAGE_LABEL,
  methodTable,
  sdkMethods,
  signature,
  type CodeLanguage,
  type CodeModeManifest,
  type SdkMethod,
} from "./code-sdk.js";
import type { SandboxLimits, SandboxOutcome } from "./code-sandbox.js";
import type { OperationResult, OperationTool } from "./operations.js";
import { buildToolIndex, searchTools, toolGroups } from "./tool-search.js";

// ─── Code mode ─────────────────────────────────────────────────────────────────
//
// An agent with a task that takes many calls writes one short script against
// the API's SDK instead of making each call a tool call: list, filter, look up,
// update, return the few fields that answer the question. Two tools stand in
// for the operations: one shows the SDK's methods, one runs a script.
//
// Every call a script makes is an ordinary operation call underneath. The
// server runs it through the same path as a tool call (permissions, approval
// prompts, practice answers, outage notes, error guides, redaction, usage), so
// a script can do nothing its tools could not, and asks for everything they
// would ask for.

export const RUN_CODE = "run_code";
export const DESCRIBE_SDK = "describe_sdk";

const CODE_TOOLS = new Set([RUN_CODE, DESCRIBE_SDK]);

export function isCodeTool(name: string): boolean {
  return CODE_TOOLS.has(name);
}

/** What one run may do, beyond the sandbox's own limits. */
export interface RunLimits {
  /** API calls per run. The session's own limits still apply to each. */
  calls: number;
  /** Calls per run that ask the user to approve them. */
  approvals: number;
  /** Characters of source a script may have. */
  sourceChars: number;
  /** The whole result text. */
  resultChars: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = { calls: 50, approvals: 10, sourceChars: 20_000, resultChars: 32_000 };

/** Methods one describe call shows at most, and the characters it may use. */
export const DESCRIBE_SDK_MAX = 15;
const DESCRIBE_BUDGET = 24_000;

// ─── Tools ─────────────────────────────────────────────────────────────────────

/**
 * The method the tool descriptions show as an example: a read that needs no
 * arguments when the API has one, so the example runs as written. An agent
 * copies the example's shape, and a placeholder API's `client.pets.list`
 * names a method this SDK does not have.
 */
function exampleMethod(methods: readonly SdkMethod[]): { method: SdkMethod; bare: boolean } | undefined {
  const needsNothing = (m: SdkMethod) => {
    const req = (m.tool.inputSchema as { required?: unknown }).required;
    return !Array.isArray(req) || req.length === 0;
  };
  const read = methods.find((m) => m.tool.http.method.toUpperCase() === "GET" && needsNothing(m));
  if (read !== undefined) return { method: read, bare: true };
  const first = methods[0];
  return first === undefined ? undefined : { method: first, bare: needsNothing(first) };
}

/** The two tools a code mode server lists in place of its operations. */
export function codeModeTools(
  languages: readonly CodeLanguage[],
  visible: readonly OperationTool[],
  limits: SandboxLimits,
  runLimits: RunLimits = DEFAULT_RUN_LIMITS,
  /** The SDK's call paths, for examples in this API's own names. Absent: a generic example. */
  manifest?: CodeModeManifest,
): Tool[] {
  const names = languages.map((l) => LANGUAGE_LABEL[l]).join(" or ");
  const grouped = toolGroups(visible).length >= 2;
  const ts = languages.includes("typescript");
  const py = languages.includes("python");
  const tsExample = manifest === undefined ? undefined : exampleMethod(sdkMethods(visible, manifest, "typescript"));
  const pyExample = manifest === undefined ? undefined : exampleMethod(sdkMethods(visible, manifest, "python"));
  const tsCall =
    tsExample === undefined
      ? "`const pets = await client.pets.list({ limit: 10 })`"
      : `\`const result = await client.${tsExample.method.path}(${tsExample.bare ? "" : "{ ... }"})\``;
  const pyCall =
    pyExample === undefined
      ? "`pets = client.pets.list(limit=10)`"
      : `\`result = client.${pyExample.method.path}(${pyExample.bare ? "" : "..."})\``;
  const pathExample = (ts ? tsExample : pyExample)?.method.path ?? "pets.list";
  const style = [
    ...(ts ? [`TypeScript: calls are async, ${tsCall}; \`console.log\` prints.`] : []),
    ...(py ? [`Python (MicroPython, a Python 3 subset with json, re, math, collections): calls block, ${pyCall}; \`print\` prints.`] : []),
  ].join(" ");
  return [
    {
      name: DESCRIBE_SDK,
      description:
        `Show this API's SDK as ${names} declarations, for writing a ${RUN_CODE} script. ` +
        `It has ${visible.length.toLocaleString("en-US")} methods. With no query or names it lists the namespaces; ` +
        `with a query it shows the best matches; with names (call paths such as "${pathExample}") it shows those, up to ${DESCRIBE_SDK_MAX}.`,
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string", enum: [...languages], description: `Which SDK to show. Default ${languages[0]}.` },
          query: { type: "string", description: 'What the methods do, in a few words, e.g. "create invoice".' },
          names: {
            type: "array",
            items: { type: "string" },
            maxItems: DESCRIBE_SDK_MAX,
            description: `Call paths under \`client\`, exactly as listed, e.g. "${pathExample}".`,
          },
          ...(grouped ? { group: { type: "string", description: "Only methods in this group." } } : {}),
        },
      },
      annotations: { title: "Describe the SDK", readOnlyHint: true, openWorldHint: false },
    },
    {
      name: RUN_CODE,
      description:
        `Run a short ${names} script against this API's SDK, for a task that takes several calls: fetch, filter, join and return only what answers it. ` +
        `The code is the body of a function with \`client\` in scope; \`return\` a JSON value as the result. ${style} ` +
        "Each SDK call is a real API call, checked like the tool it stands for: one that needs approval asks the user while the script waits. " +
        "A failed call raises ApiError (status, body, and how to fix it), ApprovalDeclined, ApprovalRequired, ApiOutage or CallLimitReached. " +
        `Limits per run: ${runLimits.calls} calls, ${Math.round(limits.execMs / 1000)} s of running time (waiting on calls does not count), ` +
        `${Math.round(limits.memoryBytes / (1024 * 1024))} MB, a result of ${Math.round(limits.resultBytes / 1000)} KB. ` +
        `No network, files or imports beyond the SDK. Read the methods with ${DESCRIBE_SDK} first.`,
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string", enum: [...languages], description: `The script's language. Default ${languages[0]}.` },
          code: { type: "string", maxLength: runLimits.sourceChars, description: "The script: a function body that returns the result." },
        },
        required: ["code"],
      },
      annotations: { title: "Run code against the SDK", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
  ];
}

// ─── describe_sdk ──────────────────────────────────────────────────────────────

export interface DescribeInput {
  language: CodeLanguage;
  query?: string;
  names?: string[];
  group?: string;
}

/** The text `describe_sdk` answers with, kept within its budget. */
export function describeSdkText(
  methods: readonly SdkMethod[],
  input: DescribeInput,
  asks: (tool: OperationTool) => boolean,
): string {
  const label = LANGUAGE_LABEL[input.language];
  const usage =
    input.language === "typescript"
      ? "In run_code, `client` is ready; every method is async: `await client.<path>({ ...args })`."
      : "In run_code, `client` is ready; every method blocks and takes keyword arguments: `client.<path>(name=value)`.";
  const byPath = new Map(methods.map((m) => [m.path, m]));
  let chosen: SdkMethod[];
  let heading: string;
  if (input.names !== undefined && input.names.length > 0) {
    const missing: string[] = [];
    chosen = [];
    for (const raw of input.names.slice(0, DESCRIBE_SDK_MAX)) {
      const name = raw.trim().replace(/^client\./, "");
      const found = byPath.get(name) ?? methods.find((m) => m.tool.name === name);
      if (found === undefined) missing.push(raw);
      else if (!chosen.includes(found)) chosen.push(found);
    }
    heading = missing.length > 0 ? `Not found: ${missing.join(", ")}. Search with a query to find the right path.` : "";
  } else if ((input.query ?? "").trim() !== "" || (input.group ?? "").trim() !== "") {
    const index = buildToolIndex(methods.map((m) => m.tool));
    const found = searchTools(index, input.query ?? "", { group: input.group, limit: DESCRIBE_SDK_MAX });
    const byTool = new Map(methods.map((m) => [m.tool.name, m]));
    chosen = found.matches.map((t) => byTool.get(t.name)).filter((m): m is SdkMethod => m !== undefined);
    heading =
      chosen.length === 0
        ? "Nothing matched. Try other words, or call describe_sdk with no arguments to see the namespaces."
        : `${chosen.length} of ${found.total} matching methods, best first.`;
  } else {
    return `${label} SDK: ${methods.length} methods. ${usage}\n\n${namespaceOverview(methods)}\n\n` +
      "Call describe_sdk with a query or names to see signatures.";
  }
  const parts = [`${label} SDK. ${usage}`, ...(heading !== "" ? [heading] : [])];
  let used = parts.join("\n").length;
  let shown = 0;
  for (const method of chosen) {
    const text = signature(method, input.language, asks(method.tool));
    if (used + text.length + 2 > DESCRIBE_BUDGET) break;
    parts.push(text);
    used += text.length + 2;
    shown += 1;
  }
  if (shown < chosen.length) parts.push(`(${chosen.length - shown} more did not fit: ask for them by name.)`);
  return parts.join("\n\n");
}

/** The namespaces and their methods, one line each, cut to fit. */
function namespaceOverview(methods: readonly SdkMethod[]): string {
  const spaces = new Map<string, string[]>();
  for (const m of methods) {
    const cut = m.path.lastIndexOf(".");
    const space = cut === -1 ? "(top level)" : m.path.slice(0, cut);
    const leaf = cut === -1 ? m.path : m.path.slice(cut + 1);
    const list = spaces.get(space);
    if (list === undefined) spaces.set(space, [leaf]);
    else list.push(leaf);
  }
  const lines: string[] = [];
  let used = 0;
  for (const [space, leaves] of spaces) {
    const shown = leaves.slice(0, 12).join(", ") + (leaves.length > 12 ? `, and ${leaves.length - 12} more` : "");
    const line = `${space} (${leaves.length}): ${shown}`;
    if (used + line.length > DESCRIBE_BUDGET - 400) {
      lines.push(`...and ${spaces.size - lines.length} more namespaces: search with a query.`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

// ─── Programs ──────────────────────────────────────────────────────────────────

export interface Program {
  source: string;
  /** Lines before the script's first line. */
  lineOffset: number;
  lineCount: number;
}

const ERROR_KINDS = {
  declined: "ApprovalDeclined",
  approval_required: "ApprovalRequired",
  outage: "ApiOutage",
  limit: "CallLimitReached",
} as const;

/** The TypeScript program: the SDK client, then the script (types already stripped) inside an async function. */
export function typeScriptProgram(methods: readonly SdkMethod[], script: string): Program {
  const errorClasses = Object.values(ERROR_KINDS)
    .map((name) => `class ${name} extends ApiError { constructor(e) { super(e); this.name = "${name}"; } }`)
    .join("\n");
  const preamble = [
    `"use strict";`,
    `const __methods = ${JSON.stringify(methodTable(methods))};`,
    `const __prefixes = new Set();`,
    `for (const p of Object.keys(__methods)) { const s = p.split("."); for (let i = 1; i < s.length; i++) __prefixes.add(s.slice(0, i).join(".")); }`,
    `class ApiError extends Error { constructor(e) { super(e.message); this.name = "ApiError"; this.kind = e.kind; this.status = e.status; this.body = e.body; } }`,
    errorClasses,
    `const __errors = ${JSON.stringify(ERROR_KINDS)};`,
    `const __classes = { ApiError, ${Object.values(ERROR_KINDS).join(", ")} };`,
    `const __show = (v) => { if (typeof v === "string") return v; try { const j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch { return String(v); } };`,
    `const __print = (...a) => __octri_write(a.map(__show).join(" ") + "\\n");`,
    `globalThis.console = { log: __print, info: __print, warn: __print, error: __print, debug: __print };`,
    `async function __invoke(m, path, args) {`,
    `  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) throw new TypeError("client." + path + " takes one object of arguments");`,
    `  const answer = JSON.parse(await __octri_call(m.tool, JSON.stringify(args === undefined ? {} : args)));`,
    `  if (answer.ok) return answer.data;`,
    `  throw new __classes[__errors[answer.error.kind] || "ApiError"](answer.error);`,
    `}`,
    `function __ns(path) {`,
    `  return new Proxy({}, { get(_, key) {`,
    `    if (typeof key !== "string" || key === "then" || key === "toJSON") return undefined;`,
    `    const full = path === "" ? key : path + "." + key;`,
    `    if (Object.prototype.hasOwnProperty.call(__methods, full)) return (args) => __invoke(__methods[full], full, args);`,
    `    if (__prefixes.has(full)) return __ns(full);`,
    `    throw new TypeError("client." + full + " does not exist. Find methods with describe_sdk.");`,
    `  } });`,
    `}`,
    `const client = __ns("");`,
    `(async () => {`,
  ];
  const body = script.split("\n");
  const tail = [
    `})().then((value) => {`,
    `  let json;`,
    `  try { json = JSON.stringify(value === undefined ? null : value); } catch (e) { __octri_fail("The return value cannot be turned into JSON: " + e.message); return; }`,
    `  __octri_result(json === undefined ? "null" : json);`,
    `}, (e) => __octri_fail(e instanceof Error ? e.name + ": " + e.message + (e.stack ? "\\n" + e.stack : "") : "Uncaught " + __show(e)));`,
  ];
  return assemble(preamble, body, tail);
}

/** The Python program: the SDK client, then the script as the body of a function. */
export function pythonProgram(methods: readonly SdkMethod[], script: string): Program {
  const preamble = [
    "import json as _json",
    "import _octri",
    // A JSON string literal is a valid Python string literal.
    `_METHODS = _json.loads(${JSON.stringify(JSON.stringify(methodTable(methods)))})`,
    "_PREFIXES = set()",
    "for _p in _METHODS:",
    "    _s = _p.split('.')",
    "    for _i in range(1, len(_s)):",
    "        _PREFIXES.add('.'.join(_s[:_i]))",
    "class ApiError(Exception):",
    "    def __init__(self, error):",
    "        super().__init__(error.get('message', ''))",
    "        self.kind = error.get('kind')",
    "        self.status = error.get('status')",
    "        self.body = error.get('body')",
    ...Object.values(ERROR_KINDS).map((name) => `class ${name}(ApiError):\n    pass`).join("\n").split("\n"),
    `_ERRORS = {${Object.entries(ERROR_KINDS).map(([k, v]) => `'${k}': ${v}`).join(", ")}}`,
    "class _Method:",
    "    def __init__(self, path, entry):",
    "        self._path = path",
    "        self._entry = entry",
    "    def __call__(self, *args, **kwargs):",
    "        if len(args) > 1 or (args and not isinstance(args[0], dict)):",
    "            raise TypeError('client.' + self._path + ' takes keyword arguments, or one dict of them')",
    "        params = self._entry.get('params', {})",
    "        body = dict(args[0]) if args else {}",
    "        for key in kwargs:",
    "            body[params.get(key, key)] = kwargs[key]",
    "        answer = _json.loads(_octri.call(self._entry['tool'], _json.dumps(body)))",
    "        if answer['ok']:",
    "            return answer.get('data')",
    "        raise _ERRORS.get(answer['error'].get('kind'), ApiError)(answer['error'])",
    "class _Namespace:",
    "    def __init__(self, path):",
    "        self._path = path",
    "    def __getattr__(self, name):",
    "        path = self._path + '.' + name if self._path else name",
    "        entry = _METHODS.get(path)",
    "        if entry is not None:",
    "            return _Method(path, entry)",
    "        if path in _PREFIXES:",
    "            return _Namespace(path)",
    "        raise AttributeError('client.' + path + ' does not exist. Find methods with describe_sdk.')",
    "client = _Namespace('')",
    "def __octri_main():",
  ];
  const lines = script.replace(/\s+$/, "").split("\n");
  const body = lines.some((l) => l.trim() !== "") ? lines.map((l) => (l.trim() === "" ? "" : `    ${l}`)) : ["    pass"];
  const tail = ["_octri.result(_json.dumps(__octri_main()))"];
  return assemble(preamble, body, tail);
}

/** Counts real lines: a preamble entry may hold several. */
function assemble(preamble: readonly string[], body: readonly string[], tail: readonly string[]): Program {
  const head = preamble.join("\n");
  return { source: [head, ...body, ...tail].join("\n"), lineOffset: head.split("\n").length, lineCount: body.length };
}

// ─── Calls from a script ───────────────────────────────────────────────────────

/** What a script's SDK call is answered with: its data, or the error the SDK raises. */
export type CallEnvelope =
  | { ok: true; data: unknown; note?: string }
  | { ok: false; error: { kind: string; message: string; status?: number; body?: unknown } };

/** The answer as data when it is JSON, else as text. */
function bodyValue(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text, safeReviver);
  } catch {
    return text;
  }
}

/** Drops keys that would set a prototype if the value were ever merged into an object. */
export function safeReviver(key: string, value: unknown): unknown {
  return key === "__proto__" || key === "constructor" || key === "prototype" ? undefined : value;
}

/**
 * The envelope for one call, from what the operation did and what the tool
 * call answered (its text already redacted, guide and outage note included).
 */
export function envelopeFor(
  op: OperationResult | undefined,
  answer: { text: string; isError: boolean; outage: boolean; limit?: Record<string, unknown> },
  redact: (text: string) => string,
): CallEnvelope {
  if (op?.held === "dry_run") return { ok: true, data: null, note: answer.text };
  // The owner's safety limit: the facts (cap, count, reset time) as the error's body.
  if (op?.held === "limited") {
    return { ok: false, error: { kind: "limit", message: answer.text, ...(answer.limit !== undefined ? { body: answer.limit } : {}) } };
  }
  if (op?.held === "declined") return { ok: false, error: { kind: "declined", message: answer.text } };
  if (op?.held === "blocked") return { ok: false, error: { kind: "approval_required", message: answer.text } };
  if (op?.ok === true && op.response !== undefined) {
    const extra = answer.text.match(/\n\nIn real use, this call asks the user to approve it before it is sent\.$/);
    return {
      ok: true,
      data: bodyValue(redact(op.response.body)),
      ...(extra !== null ? { note: extra[0].trim() } : {}),
    };
  }
  if (answer.outage) return { ok: false, error: { kind: "outage", message: answer.text, ...(op?.failedStatus != null ? { status: op.failedStatus } : {}) } };
  if (op?.failure !== undefined) {
    return {
      ok: false,
      error: { kind: "api_error", message: answer.text, status: op.failure.status, body: bodyValue(redact(op.failure.body)) },
    };
  }
  return { ok: false, error: { kind: answer.isError ? "invalid" : "api_error", message: answer.text } };
}

// ─── Results ───────────────────────────────────────────────────────────────────

/** One call a script made, as the result lists it. */
export interface CallRecord {
  tool: string;
  method: string;
  outcome: string;
}

/** The text `run_code` answers with: what the script returned, what it printed, and every call it made. */
export function runResultText(
  language: CodeLanguage,
  outcome: SandboxOutcome,
  calls: readonly CallRecord[],
  notes: readonly string[],
  limit: number,
): string {
  const label = LANGUAGE_LABEL[language];
  const sections: string[] = [];
  if (outcome.status === "ok") {
    sections.push(`${label} script finished. ${calls.length} API ${calls.length === 1 ? "call" : "calls"}.`);
    sections.push(`Result:\n${prettyResult(outcome.result ?? "null")}`);
  } else {
    sections.push(`${label} script failed. ${calls.length} API ${calls.length === 1 ? "call was" : "calls were"} made before it stopped.`);
    sections.push(`Error:\n${outcome.error ?? "Unknown error."}`);
  }
  if (outcome.logs !== "") sections.push(`Printed:\n${outcome.logs.trimEnd()}${outcome.logsTruncated ? "\n[printing past this point was dropped]" : ""}`);
  if (calls.length > 0) {
    const shown = calls.slice(0, 60).map((c) => `${c.method} ${c.tool}: ${c.outcome}`);
    if (calls.length > 60) shown.push(`...and ${calls.length - 60} more`);
    sections.push(`Calls:\n${shown.join("\n")}`);
  }
  if (notes.length > 0) sections.push([...new Set(notes)].join("\n"));
  const text = sections.join("\n\n");
  return text.length > limit ? `${text.slice(0, limit)}\n[result cut at ${limit} characters]` : text;
}

/** Pretty JSON when it fits in a screen, compact otherwise. */
function prettyResult(json: string): string {
  try {
    const pretty = JSON.stringify(JSON.parse(json), null, 2);
    return pretty.length <= 4_000 ? pretty : json;
  } catch {
    return json;
  }
}

/** The languages a server offers: what the owner turned on, that this host can run. */
export function offeredLanguages(manifest: CodeModeManifest | undefined, hostLanguages: readonly CodeLanguage[]): CodeLanguage[] {
  if (manifest === undefined) return [];
  return manifest.languages.filter((l) => hostLanguages.includes(l));
}

export { sdkMethods };
