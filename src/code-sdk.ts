import type { OperationTool } from "./operations.js";

// ─── The SDK a code mode script sees ───────────────────────────────────────────
//
// Each operation keeps the call path its generated SDK gives it (`pets.list`),
// worked out at publish by the same naming code the SDK preview uses. Inside
// the sandbox `client.pets.list(...)` sends the operation through the server's
// own call path, so the script reads like the published SDK while every call
// is still checked, approved, counted and redacted one by one.

export const CODE_LANGUAGES = ["typescript", "python"] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Mirrors `McpCodeModeManifest` in @octri/shared. */
export interface CodeModeManifest {
  /** The languages the owner turned on, in the order they were picked. */
  languages: CodeLanguage[];
  /** Per tool name: its call path per language, and its success response shape when the docs give one. */
  methods: Record<string, { typescript: string; python: string; returns?: Record<string, unknown> }>;
}

export function isCodeLanguage(value: unknown): value is CodeLanguage {
  return typeof value === "string" && (CODE_LANGUAGES as readonly string[]).includes(value);
}

export const LANGUAGE_LABEL: Record<CodeLanguage, string> = { typescript: "TypeScript", python: "Python" };

/** One SDK method a script can call. */
export interface SdkMethod {
  tool: OperationTool;
  /** Call path under `client`, cased for the language. */
  path: string;
  /** Python only: keyword name -> the operation's own argument name, where they differ. */
  params?: Record<string, string>;
  returns?: Record<string, unknown>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/** A call path is usable when every segment is an identifier of the language. */
function usablePath(path: string, language: CodeLanguage): boolean {
  if (path === "") return false;
  const pattern = language === "python" ? PY_IDENTIFIER : IDENTIFIER;
  return path.split(".").every((s) => pattern.test(s) && !(language === "python" && PY_KEYWORDS.has(s)));
}

/** `petId` -> `pet_id`, as the generated Python SDK names its keyword arguments. */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * The methods a script in this language can call: the visible operation tools
 * with a call path for it. An operation whose path is missing or clashes falls
 * back to its tool name at the top level, so nothing visible is unreachable.
 */
export function sdkMethods(
  tools: readonly OperationTool[],
  manifest: CodeModeManifest,
  language: CodeLanguage,
): SdkMethod[] {
  const taken = new Set<string>();
  const out: SdkMethod[] = [];
  for (const tool of tools) {
    const entry = manifest.methods[tool.name];
    let path = entry?.[language] ?? "";
    if (!usablePath(path, language) || taken.has(path)) {
      path = language === "python" ? snakeCase(tool.name) : tool.name;
      if (!usablePath(path, language) || taken.has(path)) continue;
    }
    taken.add(path);
    const method: SdkMethod = { tool, path, ...(entry?.returns !== undefined ? { returns: entry.returns } : {}) };
    if (language === "python") {
      const params = pythonParams(tool);
      if (Object.keys(params).length > 0) method.params = params;
    }
    out.push(method);
  }
  return out;
}

function properties(schema: unknown): Record<string, Record<string, unknown>> {
  if (schema === null || typeof schema !== "object") return {};
  const props = (schema as { properties?: unknown }).properties;
  return props !== null && typeof props === "object" ? (props as Record<string, Record<string, unknown>>) : {};
}

function required(schema: unknown): Set<string> {
  const list = schema !== null && typeof schema === "object" ? (schema as { required?: unknown }).required : undefined;
  return new Set(Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : []);
}

/** Python keyword names for the operation's arguments, where snake_case changes them. */
function pythonParams(tool: OperationTool): Record<string, string> {
  const names = Object.keys(properties(tool.inputSchema));
  const used = new Set(names);
  const map: Record<string, string> = {};
  for (const name of names) {
    const snake = snakeCase(name);
    if (snake === name || snake === "" || used.has(snake) || PY_KEYWORDS.has(snake) || !PY_IDENTIFIER.test(snake)) continue;
    used.add(snake);
    map[snake] = name;
  }
  return map;
}

/** The method map the sandbox's `client` resolves paths through. */
export function methodTable(methods: readonly SdkMethod[]): Record<string, { tool: string; params?: Record<string, string> }> {
  const table: Record<string, { tool: string; params?: Record<string, string> }> = {};
  for (const m of methods) table[m.path] = { tool: m.tool.name, ...(m.params !== undefined ? { params: m.params } : {}) };
  return table;
}

// ─── Signatures ────────────────────────────────────────────────────────────────
//
// Rendered from each operation's input schema and, when the docs give one, its
// success response. Bounded in depth and width: a describe call has a budget,
// and a type nobody can read is worth less than `unknown` and a docs lookup.

const MAX_DEPTH = 4;
const MAX_PROPS = 24;
const MAX_ENUM = 12;

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : undefined;
}

function enumValues(schema: Schema): unknown[] | undefined {
  if (Array.isArray(schema["enum"])) return schema["enum"] as unknown[];
  if ("const" in schema) return [schema["const"]];
  return undefined;
}

function variants(schema: Schema): Schema[] | undefined {
  for (const key of ["oneOf", "anyOf"]) {
    const list = schema[key];
    if (Array.isArray(list) && list.length > 0) return list.map(asSchema).filter((s): s is Schema => s !== undefined);
  }
  return undefined;
}

function typeNames(schema: Schema): string[] {
  const t = schema["type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (asSchema(schema["properties"]) !== undefined) return ["object"];
  if (schema["items"] !== undefined) return ["array"];
  return [];
}

const tsKey = (key: string) => (IDENTIFIER.test(key) ? key : JSON.stringify(key));

/** A TypeScript type for a JSON schema. */
export function tsType(value: unknown, depth = 0): string {
  const schema = asSchema(value);
  if (schema === undefined || depth > MAX_DEPTH) return "unknown";
  const values = enumValues(schema);
  if (values !== undefined) {
    const shown = values.slice(0, MAX_ENUM).map((v) => JSON.stringify(v)).join(" | ");
    return values.length > MAX_ENUM ? `${shown} | string` : shown || "unknown";
  }
  const alts = variants(schema);
  if (alts !== undefined) return [...new Set(alts.map((s) => tsType(s, depth + 1)))].join(" | ");
  if (Array.isArray(schema["allOf"])) {
    const parts = (schema["allOf"] as unknown[]).map((s) => tsType(s, depth + 1)).filter((t) => t !== "unknown");
    return parts.length > 0 ? parts.join(" & ") : "unknown";
  }
  const names = typeNames(schema);
  const rendered = names.map((name) => {
    switch (name) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return `Array<${tsType(schema["items"], depth + 1)}>`;
      case "object":
        return tsObject(schema, depth);
      default:
        return "unknown";
    }
  });
  return rendered.length > 0 ? [...new Set(rendered)].join(" | ") : "unknown";
}

function tsObject(schema: Schema, depth: number): string {
  const props = Object.entries(properties(schema));
  if (props.length === 0) return "Record<string, unknown>";
  const req = required(schema);
  const shown = props.slice(0, MAX_PROPS).map(([k, v]) => `${tsKey(k)}${req.has(k) ? "" : "?"}: ${tsType(v, depth + 1)}`);
  if (props.length > MAX_PROPS) shown.push("[key: string]: unknown");
  return `{ ${shown.join("; ")} }`;
}

/** A Python type hint for a JSON schema. Objects are dicts: results come back as plain JSON. */
export function pyType(value: unknown, depth = 0): string {
  const schema = asSchema(value);
  if (schema === undefined || depth > MAX_DEPTH) return "Any";
  const values = enumValues(schema);
  if (values !== undefined) {
    const shown = values.slice(0, MAX_ENUM).map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)));
    return values.length > MAX_ENUM ? "str" : `Literal[${shown.join(", ")}]`;
  }
  const alts = variants(schema);
  if (alts !== undefined) return [...new Set(alts.map((s) => pyType(s, depth + 1)))].join(" | ");
  if (Array.isArray(schema["allOf"])) return "dict";
  const rendered = typeNames(schema).map((name) => {
    switch (name) {
      case "string":
        return "str";
      case "integer":
        return "int";
      case "number":
        return "float";
      case "boolean":
        return "bool";
      case "null":
        return "None";
      case "array":
        return `list[${pyType(schema["items"], depth + 1)}]`;
      case "object":
        return pyDict(schema, depth);
      default:
        return "Any";
    }
  });
  return rendered.length > 0 ? [...new Set(rendered)].join(" | ") : "Any";
}

/** A dict hint that still names its keys: `dict{id: int, name: str}`. */
function pyDict(schema: Schema, depth: number): string {
  const props = Object.entries(properties(schema));
  if (props.length === 0 || depth >= MAX_DEPTH) return "dict";
  const req = required(schema);
  const shown = props.slice(0, MAX_PROPS).map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${pyType(v, depth + 1)}`);
  if (props.length > MAX_PROPS) shown.push("...");
  return `dict{${shown.join(", ")}}`;
}

function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** One method's declaration, with its summary and what calling it involves. */
export function signature(method: SdkMethod, language: CodeLanguage, asks: boolean): string {
  const { tool } = method;
  const schema = tool.inputSchema;
  const props = Object.entries(properties(schema));
  const req = required(schema);
  const notes = [
    firstLine(tool.description),
    `${tool.http.method.toUpperCase()} ${tool.http.path}`,
    ...(tool.deprecated ? ["Deprecated."] : []),
    ...(asks ? ["Asks the user to approve each call."] : []),
  ].filter((n) => n !== "");
  if (language === "typescript") {
    const optional = props.every(([k]) => !req.has(k));
    const args = props.length === 0 ? "" : `args${optional ? "?" : ""}: ${tsType(schema)}`;
    const returns = method.returns !== undefined ? tsType(method.returns) : "unknown";
    return `/** ${notes.join(" ")} */\nclient.${method.path}(${args}): Promise<${returns}>`;
  }
  const back = new Map(Object.entries(method.params ?? {}).map(([snake, original]) => [original, snake]));
  const ordered = [...props.filter(([k]) => req.has(k)), ...props.filter(([k]) => !req.has(k))];
  const kwargs = ordered.map(([k, v]) => `${back.get(k) ?? k}: ${pyType(v)}${req.has(k) ? "" : " = None"}`);
  const args = kwargs.length > 0 ? `*, ${kwargs.join(", ")}` : "";
  const returns = method.returns !== undefined ? pyType(method.returns) : "Any";
  return `client.${method.path}(${args}) -> ${returns}\n    """${notes.join(" ")}"""`;
}
