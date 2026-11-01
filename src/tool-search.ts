import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { OperationTool } from "./operations.js";

// ─── Tool listing mode ─────────────────────────────────────────────────────────
//
// An API with hundreds of endpoints, served one tool per endpoint, puts every
// schema into the client's context before the agent has read a word of the
// task. Search mode lists four tools instead: one finds operations by keyword,
// one returns the schemas of the few it picked, one runs an operation by name,
// and one lists the groups to browse. Every operation still goes through the
// same permission gate, whichever way it is reached.

/** Mirrors `McpToolMode` in @octri/shared, which this package does not depend on. */
export type ToolMode = "auto" | "all" | "search" | "code";

/** Mirrors `MCP_SEARCH_MODE_THRESHOLD`: visible operations above which `auto` searches, unless the owner set their own. */
export const SEARCH_MODE_THRESHOLD = 40;

const TOOL_MODES: readonly ToolMode[] = ["auto", "all", "search", "code"];

/** A mode from a flag or variable. Absent is undefined; anything unknown is refused. */
export function parseToolMode(raw: string | undefined): ToolMode | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const mode = raw.trim().toLowerCase();
  if ((TOOL_MODES as readonly string[]).includes(mode)) return mode as ToolMode;
  throw new Error(`Unknown tool mode "${raw}". Use all, search, code or auto.`);
}

/**
 * The listing a server serves. The person running the server has the last
 * word, then the owner's published choice, then the threshold (the owner's,
 * else the default; anything but a positive whole number is ignored). Neither choice
 * changes what may be called, only how it is offered. Code mode is never
 * chosen automatically, and where it is not available (the owner did not
 * publish it, or this host cannot run scripts) it falls back to search.
 */
export function resolveToolMode(
  user: ToolMode | undefined,
  owner: ToolMode | undefined,
  visibleTools: number,
  codeAvailable = false,
  threshold?: number,
): "all" | "search" | "code" {
  const mode = user ?? owner ?? "auto";
  if (mode === "code") return codeAvailable ? "code" : "search";
  if (mode !== "auto") return mode;
  const limit = threshold !== undefined && Number.isInteger(threshold) && threshold > 0 ? threshold : SEARCH_MODE_THRESHOLD;
  return visibleTools > limit ? "search" : "all";
}

// ─── Meta-tools ────────────────────────────────────────────────────────────────

export const SEARCH_TOOLS = "search_tools";
export const DESCRIBE_TOOL = "describe_tool";
export const CALL_TOOL = "call_tool";
export const LIST_TOOL_GROUPS = "list_tool_groups";

const META_TOOLS = new Set([SEARCH_TOOLS, DESCRIBE_TOOL, CALL_TOOL, LIST_TOOL_GROUPS]);

export function isMetaTool(name: string): boolean {
  return META_TOOLS.has(name);
}

/** How many results one search returns by default, and at most. */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;
/** Operations one `describe_tool` call returns at most. */
export const DESCRIBE_MAX = 5;

const count = (n: number) => n.toLocaleString("en-US");

/** The groups the visible operations sit in, in the order they first appear. */
export function toolGroups(tools: readonly OperationTool[]): { name: string; tools: OperationTool[] }[] {
  const groups = new Map<string, OperationTool[]>();
  for (const tool of tools) {
    const name = tool.group ?? "";
    if (name === "") continue;
    const bucket = groups.get(name);
    if (bucket === undefined) groups.set(name, [tool]);
    else bucket.push(tool);
  }
  return [...groups].map(([name, members]) => ({ name, tools: members }));
}

/**
 * The tools a search-mode server lists in place of its operations. Each
 * description says how many operations stand behind it, so the agent knows why
 * it is not seeing them and that searching is the way in.
 */
export function searchModeTools(visible: readonly OperationTool[]): Tool[] {
  const total = count(visible.length);
  const readsOnly = visible.every((t) => isRead(t.http.method));
  const grouped = toolGroups(visible).length >= 2;
  const tools: Tool[] = [
    {
      name: SEARCH_TOOLS,
      description:
        `Find this API's operations by keyword. It has ${total} operations, too many to list up front, so they are found here. ` +
        "Matches operation names, descriptions, paths and groups, best first, one line each with the required arguments. " +
        `Then call ${DESCRIBE_TOOL} for the input schema of the ones you need, and ${CALL_TOOL} to run one.` +
        (grouped ? ` Pass a group from ${LIST_TOOL_GROUPS}, with or without a query, to browse it.` : ""),
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: 'What the operation does, in a few words, e.g. "create invoice" or "list members of a team".',
          },
          ...(grouped
            ? { group: { type: "string", description: `Only operations in this group (see ${LIST_TOOL_GROUPS}).` } }
            : {}),
          limit: {
            type: "integer",
            minimum: 1,
            maximum: SEARCH_MAX_LIMIT,
            description: `How many results to return. Default ${SEARCH_DEFAULT_LIMIT}.`,
          },
          offset: { type: "integer", minimum: 0, description: "Skip this many results, to page through a long match." },
        },
      },
      annotations: { title: "Search operations", readOnlyHint: true, openWorldHint: false },
    },
    {
      name: DESCRIBE_TOOL,
      description:
        `Get the full description and input schema of up to ${DESCRIBE_MAX} operations, by the names ${SEARCH_TOOLS} returned. ` +
        `Read it before ${CALL_TOOL}: it lists every argument, which are required, and whether a call asks the user first.`,
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: DESCRIBE_MAX,
            description: "Operation names, exactly as search_tools printed them.",
          },
        },
        required: ["names"],
      },
      annotations: { title: "Describe operations", readOnlyHint: true, openWorldHint: false },
    },
    {
      name: CALL_TOOL,
      description:
        "Run one of this API's operations by name with its arguments, as described by describe_tool. " +
        "This performs the real API call. Some operations ask the user to approve each call first; " +
        "if the user declines, do not retry unless they ask you to.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The operation name." },
          arguments: {
            type: "object",
            additionalProperties: true,
            description: "The operation's arguments, matching its input schema.",
          },
        },
        required: ["name"],
      },
      annotations: {
        title: "Call an operation",
        readOnlyHint: readsOnly,
        destructiveHint: !readsOnly,
        openWorldHint: true,
      },
    },
  ];
  if (grouped) {
    tools.push({
      name: LIST_TOOL_GROUPS,
      description: `List the groups this API's ${total} operations are organized in, with how many each holds and a few examples.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "List operation groups", readOnlyHint: true, openWorldHint: false },
    });
  }
  return tools;
}

// ─── Search ────────────────────────────────────────────────────────────────────

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "for", "by", "in", "on", "and", "or", "with", "from", "into", "my", "me", "i",
  "all", "some", "this", "that", "it", "its", "is", "be", "can", "how", "do", "does",
]);

/**
 * Long words APIs routinely shorten in names and paths, folded to the short
 * form so "star a repository" finds `starRepo` and "organization" finds `/orgs`.
 */
const ABBREVIATIONS: Record<string, string> = {
  repository: "repo",
  organization: "org",
  organisation: "org",
  configuration: "config",
  authentication: "auth",
  authorization: "auth",
  application: "app",
  environment: "env",
  information: "info",
  administrator: "admin",
};

/** Folds plural and simple inflections so "repos" finds "repo" and "issues" finds "issue". */
function stem(word: string): string {
  const folded = ABBREVIATIONS[word] ?? ABBREVIATIONS[singular(word)];
  return folded ?? singular(word);
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) return word.slice(0, -1);
  return word;
}

/** Words in names, paths and prose: camelCase, snake_case, kebab-case and slashes all split. */
export function searchTerms(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "" && !STOP_WORDS.has(w))
    .map(stem);
}

/** How much a hit in each field counts. A name says the most about what a tool does. */
const FIELD_WEIGHTS = { name: 5, group: 3, path: 3, summary: 2, body: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

/** Verbs in a query that say which HTTP methods the agent means. */
const VERB_METHODS: [RegExp, readonly string[]][] = [
  [/^(create|add|new|post|make|insert|upload|send|start|open)$/, ["POST"]],
  [/^(update|edit|modify|change|set|rename|patch|replace)$/, ["PATCH", "PUT"]],
  [/^(delete|remove|destroy|cancel|revoke|close)$/, ["DELETE"]],
  [/^(list|get|find|fetch|read|show|retrieve|search|lookup|view|check)$/, ["GET"]],
];

interface IndexedField {
  counts: Map<string, number>;
  length: number;
}

interface IndexedTool {
  tool: OperationTool;
  position: number;
  fields: Record<Field, IndexedField>;
}

export interface ToolIndex {
  tools: IndexedTool[];
  /** Tools each term appears in, for its rarity. */
  frequency: Map<string, number>;
  /** Mean length of each field in words, so a hit in a short field counts for more. */
  averageLength: Record<Field, number>;
  byName: Map<string, OperationTool>;
}

function termCounts(text: string): IndexedField {
  const terms = searchTerms(text);
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return { counts, length: terms.length };
}

/** BM25's saturation and length knobs, at their usual values. */
const SATURATION = 1.2;
const LENGTH_WEIGHT = 0.75;

/** The first sentence of a description, short enough for one result line. */
export function summaryLine(description: string, max = 160): string {
  const plain = description.replace(/^\[Deprecated\]\s*/, "").trim();
  const firstLine = plain.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export function buildToolIndex(tools: readonly OperationTool[]): ToolIndex {
  const frequency = new Map<string, number>();
  const indexed = tools.map((tool, position) => {
    const summary = summaryLine(tool.description, Number.MAX_SAFE_INTEGER);
    const fields: Record<Field, IndexedField> = {
      name: termCounts(tool.name),
      group: termCounts(tool.group ?? ""),
      // Placeholders like {owner} name an argument, not what the tool does.
      path: termCounts(tool.http.path.replace(/\{[^}]*\}/g, " ")),
      summary: termCounts(summary),
      body: termCounts(tool.description.slice(tool.description.indexOf(summary) + summary.length)),
    };
    const seen = new Set<string>();
    for (const field of Object.values(fields)) for (const term of field.counts.keys()) seen.add(term);
    for (const term of seen) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return { tool, position, fields };
  });
  const averageLength = {} as Record<Field, number>;
  for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
    const total = indexed.reduce((sum, entry) => sum + entry.fields[field].length, 0);
    averageLength[field] = indexed.length > 0 ? Math.max(total / indexed.length, 1) : 1;
  }
  return { tools: indexed, frequency, averageLength, byName: new Map(tools.map((t) => [t.name, t])) };
}

export interface SearchOptions {
  group?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchResult {
  matches: OperationTool[];
  /** Every tool that matched, before the page was cut. */
  total: number;
}

function inGroup(tool: OperationTool, group: string): boolean {
  const own = (tool.group ?? "").toLowerCase();
  const wanted = group.trim().toLowerCase();
  // A parent folder takes in its subfolders: "Repos" covers "Repos / Issues".
  return own === wanted || own.startsWith(`${wanted} / `);
}

/**
 * Ranks the indexed tools against a query. A BM25-style score: each query term
 * counts for more the rarer it is across the API (so "repos" in GitHub, on half
 * the operations, says little and "fork" says a lot), weighted by the field it
 * hit, saturated so a word repeated in a long description cannot outrank a
 * name, and scaled by field length so a short name that is exactly the query
 * beats a long one that merely contains it. Tools matching more of the query come first; a verb like "create" lifts
 * the operations whose method does that; deprecated ones sink.
 */
export function searchTools(index: ToolIndex, query: string, options: SearchOptions = {}): SearchResult {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT), 1), SEARCH_MAX_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const group = options.group?.trim() ?? "";
  const pool = group === "" ? index.tools : index.tools.filter((t) => inGroup(t.tool, group));

  const terms = [...new Set(searchTerms(query))];
  if (terms.length === 0) {
    // Browsing a group: every member, in the API's own order.
    const all = group === "" ? [] : pool.map((t) => t.tool);
    return { matches: all.slice(offset, offset + limit), total: all.length };
  }

  const n = index.tools.length;
  const methods = new Set<string>();
  for (const term of terms) {
    for (const [pattern, verbs] of VERB_METHODS) if (pattern.test(term)) verbs.forEach((m) => methods.add(m));
  }
  const exact = query.trim().toLowerCase();

  const scored: { tool: OperationTool; score: number; position: number }[] = [];
  for (const entry of pool) {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      let hit = 0;
      for (const field of Object.keys(FIELD_WEIGHTS) as Field[]) {
        const { counts, length } = entry.fields[field];
        const tf = counts.get(term) ?? 0;
        if (tf === 0) continue;
        const norm = 1 - LENGTH_WEIGHT + (LENGTH_WEIGHT * length) / index.averageLength[field];
        hit += (FIELD_WEIGHTS[field] * tf * (SATURATION + 1)) / (tf + SATURATION * norm);
      }
      if (hit === 0) continue;
      matched += 1;
      const df = index.frequency.get(term) ?? 0;
      score += hit * Math.log(1 + (n - df + 0.5) / (df + 0.5));
    }
    if (entry.tool.name.toLowerCase() === exact) score += 1_000;
    if (score === 0) continue;
    score *= 1 + matched / terms.length;
    if (methods.has(entry.tool.http.method)) score *= 1.25;
    if (entry.tool.deprecated) score *= 0.5;
    scored.push({ tool: entry.tool, score, position: entry.position });
  }
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  return { matches: scored.slice(offset, offset + limit).map((s) => s.tool), total: scored.length };
}

// ─── Result text ───────────────────────────────────────────────────────────────

function requiredArguments(tool: OperationTool): string[] {
  const required = (tool.inputSchema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [];
}

/** One search result: everything needed to pick it, nothing needed only to call it. */
export function resultLine(
  tool: OperationTool,
  asksFirst: boolean,
  health?: "down" | "degraded",
  changed?: "new" | "changed" | "breaking",
): string {
  const args = requiredArguments(tool);
  return [
    tool.name,
    `${tool.http.method} ${tool.http.path}`,
    summaryLine(tool.description),
    args.length > 0 ? `requires: ${args.join(", ")}` : "no required arguments",
    ...(asksFirst ? ["asks the user first"] : []),
    ...(tool.deprecated ? ["deprecated"] : []),
    ...(health === "down"
      ? ["failing now, per Octri monitoring"]
      : health === "degraded"
        ? ["slow now, per Octri monitoring"]
        : []),
    ...(changed === "new"
      ? ["new since you last connected"]
      : changed === "breaking"
        ? ["changed since you last connected (breaking)"]
        : changed === "changed"
          ? ["changed since you last connected"]
          : []),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}
