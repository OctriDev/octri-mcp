#!/usr/bin/env node

/**
 * Octri MCP Server
 *
 * Exposes an Octri project to AI assistants (Claude, Cursor, etc.) as MCP tools:
 *   - Docs tools: search, retrieve, and navigate the project's documentation.
 *   - Operation tools: one executable tool per included endpoint, shaped by the
 *     owner's SDK Studio config (names, doc comments, inclusion, deprecation).
 *     These PERFORM the real API call, using credentials from the env below.
 *
 * Env:
 *   OCTRI_PROJECT_ID / --project-id   the project to expose
 *   OCTRI_API_URL                     the Octri API (defaults to prod)
 *   OCTRI_API_BASE_URL                the TARGET API base for operation calls
 *                                     (falls back to the studio's Base URL)
 *   OCTRI_API_TOKEN                   bearer / oauth2 token (or basic creds)
 *   OCTRI_API_KEY (+ _HEADER)         apiKey value (+ header name, def X-API-Key)
 *   OCTRI_API_USERNAME / _PASSWORD    basic-auth credentials
 *
 * All of the above are sent as HTTP HEADERS. An API that takes its credentials
 * in the request body instead (Plaid's `client_id` / `secret`, for one) is not
 * served by them: those fields are ordinary body parameters, so the agent passes
 * them as tool arguments like any other field. Setting OCTRI_API_KEY for such an
 * API adds a header it ignores and changes nothing about whether a call
 * authenticates.
 *
 * Transports:
 *   stdio (default)   for Claude Desktop / Cursor local integrations
 *   http              Streamable HTTP for remote hosting (MCP_TRANSPORT=http).
 *                     The transport the current spec defines — POST /mcp.
 *   sse               legacy HTTP+SSE (MCP_TRANSPORT=sse), superseded in spec
 *                     revision 2025-03-26 and kept for existing deployments.
 *                     New hosting should use `http`.
 *
 * HTTP transport env (http and sse):
 *   PORT                              port to bind (default 3000)
 *   MCP_HOST                          interface to bind (default 127.0.0.1)
 *   MCP_ALLOWED_ORIGINS               comma-separated browser origins allowed
 *                                     to reach the transport (default none)
 *   MCP_AUTH_TOKEN                    bearer token every request must present.
 *                                     Required once MCP_HOST is not loopback.
 */

import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.octri.dev/api/v1";

/**
 * Reported to the client in the MCP handshake. Read from the manifest rather
 * than pinned in source, where it sat at 1.0.0 for every published release and
 * made the version a client sees meaningless for support or telemetry.
 */
const SERVER_VERSION = ((): string => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

interface Config {
  projectId: string;
  apiUrl: string;
  transport: string;
  port: number;
  /** Interface the SSE transport binds to. Loopback unless deliberately widened. */
  host: string;
  /** Browser origins allowed to reach the SSE transport. Empty means none. */
  allowedOrigins: Set<string>;
  /** Bearer token every HTTP request must carry. Empty means none is asked for. */
  authToken: string;
}

function loadConfig(): Config {
  // CLI flag --project-id takes precedence over env var
  const args = process.argv.slice(2);
  let cliProjectId: string | undefined;
  const pidIdx = args.indexOf("--project-id");
  if (pidIdx !== -1) {
    cliProjectId = args[pidIdx + 1];
  }

  return {
    projectId: cliProjectId ?? process.env["OCTRI_PROJECT_ID"] ?? "",
    apiUrl: process.env["OCTRI_API_URL"] ?? DEFAULT_API_URL,
    transport: process.env["MCP_TRANSPORT"] ?? "stdio",
    port: parseInt(process.env["PORT"] ?? "3000", 10),
    host: process.env["MCP_HOST"] ?? "127.0.0.1",
    allowedOrigins: new Set(
      (process.env["MCP_ALLOWED_ORIGINS"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
    authToken: process.env["MCP_AUTH_TOKEN"] ?? "",
  };
}

// ─── API client ────────────────────────────────────────────────────────────────

/**
 * A failed Octri API call, phrased for the agent reading it. The status is kept
 * so a caller can tell "you asked for something that isn't there" apart from
 * "the service is down" — advice the model can act on either way.
 */
class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? "Not found. Check the slug and projectId — list_endpoints shows what this project actually exposes."
        : status === 429
          ? "Rate limited by the Octri API. Wait a moment and retry."
          : `The Octri API returned HTTP ${status}.`,
    );
    this.name = "ApiError";
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Full detail goes to the operator's log. The model gets a sentence it can
    // act on: handing it an internal endpoint and a raw error payload told it
    // nothing about which argument to change, and leaked the API's shape.
    process.stderr.write(`Octri API ${res.status} from ${url}: ${body.slice(0, 500)}\n`);
    throw new ApiError(res.status);
  }

  return res.json() as Promise<T>;
}

// ─── Tool schemas ──────────────────────────────────────────────────────────────

/**
 * Every docs tool accepts a `projectId`, but the server already knows which
 * project it serves (`--project-id` / `OCTRI_PROJECT_ID`). Marking it required
 * pushed the model to invent one, and a wrong id silently reads another
 * project, so it is advertised as the optional override it actually is.
 */
const PROJECT_ID_DESCRIPTION =
  "Project to read. Optional — defaults to the project this server was started with. Only pass it to target a different project.";

const DOCS_TOOLS: Tool[] = [
  {
    name: "search_docs",
    description: "Search the API documentation for an endpoint or concept",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_endpoint",
    description: "Get full documentation for a specific API endpoint",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        slug: {
          type: "string",
          description: "The endpoint slug",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "list_endpoints",
    description: "List all available API endpoints",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        section: {
          type: "string",
          description: "Filter by section/tag name",
        },
      },
      required: [],
    },
  },
  {
    name: "get_changelog",
    description: "Get recent API changes and breaking changes",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        breakingOnly: {
          type: "boolean",
          description: "Only return entries with breaking changes (default false)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_sdks",
    description: "List the available SDK client libraries for this API (languages, versions, and download links)",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
      },
      required: [],
    },
  },
  {
    name: "get_guide",
    description: "Get the full content of a written guide (tutorial / conceptual doc) by its slug",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        slug: {
          type: "string",
          description: "The guide slug (from list_endpoints)",
        },
        groupSlug: {
          type: "string",
          description: "The guide's section slug, if it belongs to one",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "get_sdk_methods",
    description:
      "Show how to call this API through its generated SDKs. Ready-to-use code snippets per endpoint in every supported language. Use `slug` (from list_endpoints) to focus on one endpoint, and `language` (e.g. typescript, python, go) to focus on one language.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        slug: {
          type: "string",
          description: "Focus on a single endpoint by its slug. Omit to return all endpoints.",
        },
        language: {
          type: "string",
          description: "Focus on one SDK language (e.g. typescript, python, go). Omit for all supported languages.",
        },
      },
      required: [],
    },
  },
];

/**
 * Behavioural hints, per the MCP tool-annotations contract. A client uses them
 * to decide what may run unattended: reading documentation is not the same risk
 * as issuing a DELETE against a live API, and a client given no hints has to
 * assume the worst about both.
 */
const DOCS_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // They read the Octri API over the network, not a closed local set.
  openWorldHint: true,
} as const;

const TOOLS: Tool[] = DOCS_TOOLS.map((tool) => ({
  ...tool,
  annotations: { title: tool.name, ...DOCS_TOOL_ANNOTATIONS },
}));

/** The same hints for one generated operation tool, read off its HTTP method. */
export function operationAnnotations(method: string): Tool["annotations"] {
  const verb = method.toUpperCase();
  const readOnly = verb === "GET" || verb === "HEAD";
  return {
    readOnlyHint: readOnly,
    destructiveHint: verb === "DELETE",
    idempotentHint: readOnly || verb === "PUT" || verb === "DELETE",
    // Every operation tool calls a third-party API.
    openWorldHint: true,
  };
}

// ─── Tool: search_docs ─────────────────────────────────────────────────────────

interface SearchResult {
  slug: string;
  title: string;
  method?: string;
  path?: string;
}

async function searchDocs(
  apiUrl: string,
  projectId: string,
  query: string,
  limit: number,
): Promise<string> {
  const all = await apiFetch<SearchResult[]>(
    `${apiUrl}/public/docs/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(query)}`,
  );
  const results = all.slice(0, limit);

  if (results.length === 0) {
    return "No results found for that query.";
  }

  return results
    .map((r, i) => {
      const badge =
        r.method !== undefined && r.path !== undefined
          ? ` \`${r.method} ${r.path}\``
          : "";
      return `${i + 1}. **${r.title}**${badge}\n   Slug: \`${r.slug}\``;
    })
    .join("\n\n");
}

// ─── Tool: get_endpoint ────────────────────────────────────────────────────────

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
}

interface ResponseEntry {
  description?: string;
}

interface CodeExample {
  language: string;
  code: string;
}

interface DocPage {
  slug: string;
  title: string;
  description?: string;
  method?: string;
  path?: string;
  parameters?: Parameter[];
  responses?: Record<string, ResponseEntry>;
  codeExamples?: CodeExample[];
}

interface PageResponse {
  page: DocPage;
  project: { name: string };
  spec: { version: string | null };
}

function formatEndpoint(data: PageResponse): string {
  const { page, project, spec } = data;
  const lines: string[] = [];

  lines.push(`# ${page.title}`);
  if (spec.version !== null) lines.push(`**Version:** ${spec.version}`);
  lines.push(`**Project:** ${project.name}`);
  if (page.method !== undefined && page.path !== undefined) {
    lines.push(`\`${page.method} ${page.path}\``);
  }
  lines.push("");

  if (page.description !== undefined && page.description !== "") {
    lines.push(page.description);
    lines.push("");
  }

  if (page.parameters !== undefined && page.parameters.length > 0) {
    lines.push("## Parameters");
    for (const p of page.parameters) {
      const req = p.required ? " *(required)*" : "";
      const desc = p.description !== undefined ? `: ${p.description}` : "";
      lines.push(`- **${p.name}** (${p.in})${req}${desc}`);
    }
    lines.push("");
  }

  if (page.responses !== undefined) {
    const entries = Object.entries(page.responses);
    if (entries.length > 0) {
      lines.push("## Responses");
      for (const [code, resp] of entries) {
        const desc = resp.description !== undefined ? `: ${resp.description}` : "";
        lines.push(`- **${code}**${desc}`);
      }
      lines.push("");
    }
  }

  if (page.codeExamples !== undefined && page.codeExamples.length > 0) {
    lines.push("## Code Examples");
    for (const ex of page.codeExamples) {
      lines.push(`\`\`\`${ex.language}`);
      lines.push(ex.code);
      lines.push("```");
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function getEndpoint(
  apiUrl: string,
  projectId: string,
  slug: string,
): Promise<string> {
  const data = await apiFetch<PageResponse>(
    `${apiUrl}/public/docs/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(slug)}`,
  );
  return formatEndpoint(data);
}

// ─── Tool: list_endpoints ──────────────────────────────────────────────────────

interface NavItem {
  slug: string;
  title: string;
  method?: string;
  path?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface NavResponse {
  sections: NavSection[];
}

function formatNav(data: NavResponse, section: string | undefined): string {
  let sections = data.sections;

  if (section !== undefined && section !== "") {
    const lower = section.toLowerCase();
    sections = sections.filter((s) => s.title.toLowerCase().includes(lower));
  }

  if (sections.length === 0) {
    return section !== undefined
      ? `No endpoints found in section "${section}".`
      : "No endpoints found.";
  }

  return sections
    .map((s) => {
      const items = s.items
        .map((item) => {
          const badge =
            item.method !== undefined && item.path !== undefined
              ? ` \`${item.method} ${item.path}\``
              : "";
          return `  - **${item.title}**${badge} (slug: \`${item.slug}\`)`;
        })
        .join("\n");
      return `### ${s.title}\n${items}`;
    })
    .join("\n\n");
}

async function listEndpoints(
  apiUrl: string,
  projectId: string,
  section: string | undefined,
): Promise<string> {
  const data = await apiFetch<NavResponse>(
    `${apiUrl}/public/docs/${encodeURIComponent(projectId)}/nav`,
  );
  return formatNav(data, section);
}

// ─── Tool: get_changelog ───────────────────────────────────────────────────────

interface ChangelogSummary {
  added: number;
  removed: number;
  changed: number;
  totalBreaking: number;
  totalPotentiallyBreaking: number;
  totalNonBreaking: number;
}

interface ChangelogEntry {
  id: string;
  fromVersion: string;
  toVersion: string;
  hasBreakingChanges: boolean;
  generatedAt: string;
  markdown?: string | null;
  summary?: ChangelogSummary | null;
}

interface ChangelogListResponse {
  changelogs: ChangelogEntry[];
  total: number;
  release?: {
    revision: number;
    version: string;
    publishedAt: string;
    changelog: string;
  };
}

export function formatChangelog(
  entries: ChangelogEntry[],
  breakingOnly: boolean,
  release?: ChangelogListResponse["release"],
): string {
  const subset = breakingOnly
    ? entries.filter((e) => e.hasBreakingChanges).slice(0, 3)
    : entries.slice(0, 3);

  const history = subset
    .map((entry) => {
      const date = new Date(entry.generatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const breakingTag = entry.hasBreakingChanges
        ? " (**Breaking changes**)"
        : "";
      const lines = [
        `## ${entry.fromVersion} → ${entry.toVersion}${breakingTag}`,
        `*${date}*`,
        "",
      ];

      if (entry.markdown !== null && entry.markdown !== undefined) {
        lines.push(entry.markdown);
      } else if (entry.summary !== null && entry.summary !== undefined) {
        lines.push(`- Added: ${entry.summary.added}`);
        lines.push(`- Removed: ${entry.summary.removed}`);
        lines.push(`- Changed: ${entry.summary.changed}`);
        lines.push(`- Breaking: ${entry.summary.totalBreaking}`);
        lines.push(
          `- Potentially breaking: ${entry.summary.totalPotentiallyBreaking}`,
        );
      }

      return lines.join("\n");
    })
    .join("\n\n---\n\n");

  if (breakingOnly) {
    return history === "" ? "No breaking changes found in recent history." : history;
  }

  const note = release?.changelog.trim();
  const releaseNote = release !== undefined && note !== undefined && note !== ""
    ? `## Release v${release.version}\n\n${note}`
    : "";
  if (releaseNote !== "" && history !== "") return `${releaseNote}\n\n---\n\n${history}`;
  if (releaseNote !== "") return releaseNote;
  if (history === "") {
    return breakingOnly
      ? "No breaking changes found in recent history."
      : "No changelog entries found.";
  }
  return history;
}

async function getChangelog(
  apiUrl: string,
  projectId: string,
  breakingOnly: boolean,
): Promise<string> {
  const data = await apiFetch<ChangelogListResponse>(
    `${apiUrl}/public/changelog/${encodeURIComponent(projectId)}`,
  );
  return formatChangelog(data.changelogs, breakingOnly, data.release);
}

// ─── Tool: list_sdks ───────────────────────────────────────────────────────────

interface SdkBuild {
  lang: string;
  version: string;
  downloadUrl: string;
}

interface SdkArtifactsResponse {
  builds: SdkBuild[];
  cdnEnabled: boolean;
}

async function listSdks(apiUrl: string, projectId: string): Promise<string> {
  const data = await apiFetch<SdkArtifactsResponse>(
    `${apiUrl}/public/sdk/${encodeURIComponent(projectId)}/latest-artifacts`,
  );

  if (data.builds.length === 0) {
    return "No SDK client libraries have been published for this API yet.";
  }

  const rows = data.builds
    .map((b) => `- **${b.lang}** v${b.version}, download: ${b.downloadUrl}`)
    .join("\n");

  const cdnNote = data.cdnEnabled
    ? "\n\nThese SDKs are also available via the hosted CDN."
    : "";

  return `## Available SDKs\n\n${rows}${cdnNote}`;
}

// ─── Tool: get_guide ───────────────────────────────────────────────────────────

interface PublicGuide {
  slug: string;
  title: string;
  compiledHtml: string;
  group: { slug: string; title: string } | null;
}

/** Crudely turns the compiled HTML into readable plain text for AI context. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|pre|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getGuide(
  apiUrl: string,
  projectId: string,
  slug: string,
  groupSlug: string | undefined,
): Promise<string> {
  const pid = encodeURIComponent(projectId);
  const path =
    groupSlug !== undefined && groupSlug !== ""
      ? `${apiUrl}/public/docs/${pid}/guides/${encodeURIComponent(groupSlug)}/${encodeURIComponent(slug)}`
      : `${apiUrl}/public/docs/${pid}/guides/${encodeURIComponent(slug)}`;

  const data = await apiFetch<{ guide: PublicGuide }>(path);
  const guide = data.guide;
  const section = guide.group !== null ? `\n*Section: ${guide.group.title}*` : "";
  return `# ${guide.title}${section}\n\n${htmlToText(guide.compiledHtml)}`;
}

// ─── Tool: get_sdk_methods ─────────────────────────────────────────────────────

interface SdkMethod {
  slug: string;
  title: string;
  method: string | null;
  path: string | null;
  methodName: string;
  snippets: Record<string, string>;
}

interface SdkMethodsResponse {
  languages: string[];
  endpoints: SdkMethod[];
}

function formatSdkMethods(data: SdkMethodsResponse, slug: string | undefined): string {
  if (data.endpoints.length === 0) {
    return slug !== undefined && slug !== ""
      ? `No SDK method found for endpoint "${slug}".`
      : "No SDK methods are available for this project yet.";
  }

  return data.endpoints
    .map((ep) => {
      const id = `${ep.method ?? ""} ${ep.path ?? ""}`.trim();
      const blocks = Object.entries(ep.snippets)
        .map(([lang, code]) => `**${lang}**\n\`\`\`${lang}\n${code}\n\`\`\``)
        .join("\n\n");
      return `## ${ep.title}: \`${ep.methodName}()\`\n\`${id}\`\n\n${blocks}`;
    })
    .join("\n\n---\n\n");
}

async function getSdkMethods(
  apiUrl: string,
  projectId: string,
  slug: string | undefined,
  language: string | undefined,
): Promise<string> {
  const params = new URLSearchParams();
  if (slug !== undefined && slug !== "") params.set("slug", slug);
  if (language !== undefined && language !== "") params.set("language", language);
  const qs = params.toString();
  const url = `${apiUrl}/public/sdk/${encodeURIComponent(projectId)}/methods${qs !== "" ? `?${qs}` : ""}`;

  const data = await apiFetch<SdkMethodsResponse>(url);
  return formatSdkMethods(data, slug);
}

// ─── Operation tools (executable, config-derived) ───────────────────────────────
//
// One tool per included endpoint, shaped by the owner's SDK Studio config
// (names, doc comments, inclusion, deprecation). Unlike the docs tools above,
// these actually PERFORM the API call. Fetched from the public tools endpoint,
// which returns each tool's JSON-Schema input + an `http` execution mapping.

interface ParamBinding {
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

export interface HttpMapping {
  method: string;
  path: string;
  pathParams: ParamBinding[];
  queryParams: ParamBinding[];
  /** Declared OpenAPI `in: header` parameters. */
  headerParams?: ParamBinding[];
  /** Declared OpenAPI `in: cookie` parameters. */
  cookieParams?: ParamBinding[];
  bodyParams: ParamBinding[];
  constants: HttpConstant[];
  requestBody?: RequestBodyMapping;
}

export interface OperationTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  deprecated: boolean;
  http: HttpMapping;
}

interface McpToolsResponse {
  tools: OperationTool[];
  baseUrl: string;
  auth: string;
}

// Short-lived per-project cache so a ListTools→CallTool exchange only fetches
// once; config changes still surface within the TTL.
const toolCache = new Map<string, { at: number; data: McpToolsResponse }>();
const TOOL_TTL_MS = 30_000;
// Capped as well, since the project id varies per session over SSE.
const TOOL_CACHE_MAX = 64;

async function fetchOperationTools(apiUrl: string, projectId: string): Promise<McpToolsResponse> {
  const cached = toolCache.get(projectId);
  if (cached !== undefined && Date.now() - cached.at < TOOL_TTL_MS) return cached.data;
  const data = await apiFetch<McpToolsResponse>(
    `${apiUrl}/public/mcp/${encodeURIComponent(projectId)}/tools`,
  );
  if (toolCache.size >= TOOL_CACHE_MAX) {
    const oldest = toolCache.keys().next();
    if (oldest.done !== true) toolCache.delete(oldest.value);
  }
  toolCache.set(projectId, { at: Date.now(), data });
  return data;
}

/** Credentials for the target API come from the end-user's env, keyed by scheme. */
function authHeaders(auth: string): Record<string, string> {
  const token = process.env["OCTRI_API_TOKEN"] ?? "";
  const apiKey = process.env["OCTRI_API_KEY"] ?? "";
  switch (auth) {
    case "bearer":
    case "oauth2":
      return token !== "" ? { Authorization: `Bearer ${token}` } : {};
    case "apiKey": {
      const header = process.env["OCTRI_API_KEY_HEADER"] ?? "X-API-Key";
      return apiKey !== "" ? { [header]: apiKey } : {};
    }
    case "basic": {
      const user = process.env["OCTRI_API_USERNAME"] ?? "";
      const pass = process.env["OCTRI_API_PASSWORD"] ?? "";
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
interface OperationResult {
  ok: boolean;
  text: string;
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
 * API answered 404, while a missing body field was simply dropped — both of
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
 * strict API — it reads as an unparseable one, and the request fails on the body
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

interface SerializedRequestBody {
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
  if (http.bodyParams.length === 0 && supplied !== undefined && !isRecord(supplied)) return supplied;
  const source = isRecord(supplied) ? supplied : {};
  // A root object with no editable bindings still has to retain its supplied
  // fields so body constants can be applied. Root scalar/array values returned
  // above stay untouched.
  const value: Record<string, unknown> = http.bodyParams.length === 0 ? { ...source } : {};
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
): void {
  if (encoding.headers !== undefined || encoding.contentType !== undefined) {
    throw new Error(`Unsupported explicit form encoding for ${key}; form part headers/contentType require an upstream client.`);
  }
  const style = encoding.style ?? "form";
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
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return {};

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
          appendUrlEncodedField(form, key, field, encoding);
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

/** Build + perform the real API call for one operation tool, return a text result. */
async function executeOperation(
  tool: OperationTool,
  meta: McpToolsResponse,
  args: Record<string, unknown>,
): Promise<OperationResult> {
  const baseUrl = (process.env["OCTRI_API_BASE_URL"] ?? meta.baseUrl ?? "").replace(/\/+$/, "");
  if (baseUrl === "") {
    return {
      ok: false,
      text: "Error: no API base URL configured. Set OCTRI_API_BASE_URL, or set a Base URL in the SDK Studio (Output tab).",
    };
  }

  const absent = missingRequired(tool.inputSchema, args);
  if (absent.length > 0) {
    return {
      ok: false,
      text: `Error: ${tool.name} is missing required ${absent.length === 1 ? "argument" : "arguments"}: ${absent.join(", ")}.`,
    };
  }

  const http = tool.http;
  const method = http.method.toUpperCase();
  const path = fillPath(http, args);

  const query: QueryPair[] = [];
  for (const q of http.queryParams) {
    const v = args[q.name];
    if (v !== undefined && v !== null && v !== "") appendQueryParameter(query, q, v);
  }
  for (const c of http.constants) {
    if (c.location === "query") query.push({ name: c.wireName, value: String(c.value), allowReserved: false });
  }
  const qs = query.map((pair) => `${encodeURIComponent(pair.name)}=${encodeQueryValue(pair.value, pair.allowReserved)}`).join("&");

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
  for (const [name, value] of Object.entries(authHeaders(meta.auth))) headers.set(name, value);

  const res = await fetch(url, {
    method,
    headers,
    ...(requestBody.body !== undefined ? { body: requestBody.body } : {}),
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  });

  // Return the raw response (even on 4xx/5xx) so the agent can read the error,
  // but report the transport status honestly: a 4xx surfaced as a successful
  // tool result is indistinguishable from real data to a model.
  const text = await readCapped(res, MAX_RESPONSE_BYTES).catch(() => "");
  const status = `${res.status}${res.statusText !== "" ? ` ${res.statusText}` : ""}`;
  return {
    ok: res.ok && !isSlackSemanticError(url, text),
    text: `${method} ${url} → ${status}\n\n${text !== "" ? text : "(empty response body)"}`,
  };
}

// ─── MCP server factory ────────────────────────────────────────────────────────

function buildServer(config: Config): Server {
  const server = new Server(
    { name: "@octri/mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Docs tools are always available; operation tools are config-derived and
    // fetched live. If the endpoint is unreachable, degrade to docs tools only.
    let opTools: Tool[] = [];
    if (config.projectId !== "") {
      try {
        const data = await fetchOperationTools(config.apiUrl, config.projectId);
        opTools = data.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.name, ...operationAnnotations(t.http.method) },
        }));
      } catch (err) {
        // Degrading to docs-only keeps the server usable, but doing it silently
        // meant a typo'd project id or an unreachable API was indistinguishable
        // from a project that genuinely has no endpoints — the tool list just
        // came back short, with nothing to explain it. Say so once, on stderr,
        // where the client's server log will show it.
        process.stderr.write(
          `Warning: could not load operation tools for project ${config.projectId}: ${String(err)}\n` +
            `  Serving documentation tools only. Check --project-id / OCTRI_PROJECT_ID and OCTRI_API_URL.\n`,
        );
      }
    }
    return { tools: [...TOOLS, ...opTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Allow per-call projectId override; fall back to env/flag default
    const projectId =
      typeof a["projectId"] === "string" && a["projectId"] !== ""
        ? a["projectId"]
        : config.projectId;

    if (projectId === "") {
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: projectId is required. Set the OCTRI_PROJECT_ID environment variable or pass --project-id on the command line.",
          },
        ],
        isError: true,
      };
    }

    try {
      // Operation tools (executable, config-derived) aren't in the static docs
      // set, so resolve + perform the real API call for them.
      if (!TOOLS.some((t) => t.name === name)) {
        const data = await fetchOperationTools(config.apiUrl, projectId);
        const tool = data.tools.find((t) => t.name === name);
        if (tool !== undefined) {
          const result = await executeOperation(tool, data, a);
          return {
            content: [{ type: "text" as const, text: result.text }],
            ...(result.ok ? {} : { isError: true }),
          };
        }
        // Not a known operation tool → fall through to the unknown-tool default.
      }

      let text: string;

      switch (name) {
        case "search_docs": {
          const query = typeof a["query"] === "string" ? a["query"] : "";
          const limit = typeof a["limit"] === "number" ? a["limit"] : 5;
          text = await searchDocs(config.apiUrl, projectId, query, limit);
          break;
        }
        case "get_endpoint": {
          const slug = typeof a["slug"] === "string" ? a["slug"] : "";
          text = await getEndpoint(config.apiUrl, projectId, slug);
          break;
        }
        case "list_endpoints": {
          const section =
            typeof a["section"] === "string" ? a["section"] : undefined;
          text = await listEndpoints(config.apiUrl, projectId, section);
          break;
        }
        case "get_changelog": {
          const breakingOnly = a["breakingOnly"] === true;
          text = await getChangelog(config.apiUrl, projectId, breakingOnly);
          break;
        }
        case "list_sdks": {
          text = await listSdks(config.apiUrl, projectId);
          break;
        }
        case "get_guide": {
          const slug = typeof a["slug"] === "string" ? a["slug"] : "";
          const groupSlug = typeof a["groupSlug"] === "string" ? a["groupSlug"] : undefined;
          text = await getGuide(config.apiUrl, projectId, slug, groupSlug);
          break;
        }
        case "get_sdk_methods": {
          const slug = typeof a["slug"] === "string" ? a["slug"] : undefined;
          const lang = typeof a["language"] === "string" ? a["language"] : undefined;
          text = await getSdkMethods(config.apiUrl, projectId, slug, lang);
          break;
        }
        default:
          return {
            content: [
              { type: "text" as const, text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── SSE transport (remote hosting) ───────────────────────────────────────────

const MAX_SSE_SESSIONS = 64;

/** Drops a trailing `:port`, unwrapping a bracketed IPv6 literal on the way. */
function bareHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  // One colon is host:port. More than one is a bare IPv6 address.
  const parts = trimmed.split(":");
  return parts.length === 2 ? (parts[0] ?? "") : trimmed;
}

function isLoopback(host: string): boolean {
  const bare = bareHost(host);
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/**
 * Guards both HTTP transports against a browser on the same machine. This server
 * holds API credentials, and any page the user visits can reach a loopback port.
 * An unlisted `Origin` marks a browser request and is refused; a non-loopback
 * `Host` catches DNS rebinding, which otherwise arrives looking local.
 *
 * Returns an error string when the request must be refused.
 */
export function httpRequestRefusal(
  headers: http.IncomingHttpHeaders,
  config: Pick<Config, "host" | "allowedOrigins"> & Partial<Pick<Config, "authToken">>,
): string | null {
  const origin = headers.origin;
  if (typeof origin === "string" && origin !== "") {
    if (!config.allowedOrigins.has(origin)) {
      return `Origin ${origin} is not allowed. Set MCP_ALLOWED_ORIGINS to permit it.`;
    }
  }

  // Every request answers with this server's API credentials, so once it is
  // reachable from the network the caller has to prove who it is.
  const token = config.authToken ?? "";
  if (token !== "" && !sameSecret(headers.authorization ?? "", `Bearer ${token}`)) {
    return "A valid Authorization: Bearer token is required.";
  }

  // Only meaningful while bound to loopback. A widened MCP_HOST means the
  // operator is fronting this themselves.
  if (isLoopback(config.host)) {
    const host = headers.host ?? "";
    if (!isLoopback(host)) {
      return `Host ${host === "" ? "(missing)" : host} is not the loopback interface.`;
    }
  }

  return null;
}

/** Constant-time comparison, so response timing says nothing about the token. */
function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Refuses to serve HTTP on a non-loopback interface without MCP_AUTH_TOKEN.
 * Bound wider, anyone who can reach the port used the operator's API
 * credentials, and the README's "behind a proxy you control" was the only
 * thing in the way.
 */
export function httpStartupRefusal(config: Pick<Config, "host" | "authToken">): string | null {
  if (isLoopback(config.host) || config.authToken !== "") return null;
  return `MCP_HOST=${config.host} is not the loopback interface. Set MCP_AUTH_TOKEN so only callers with the token can use this server.`;
}

async function startSse(config: Config): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${config.port}`,
    );

    const refusal = httpRequestRefusal(req.headers, config);
    if (refusal !== null) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Forbidden: ${refusal}` }));
      return;
    }

    // GET /sse: open a new SSE connection
    if (req.method === "GET" && url.pathname === "/sse") {
      if (sessions.size >= MAX_SSE_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many open sessions" }));
        return;
      }
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);

      const server = buildServer(config);
      server.connect(transport).catch((err: unknown) => {
        process.stderr.write(`SSE connect error: ${String(err)}\n`);
      });

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
      };
      return;
    }

    // POST /messages?sessionId=X: forward client message to the right session
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = sessions.get(sessionId);

      if (transport === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      transport.handlePostMessage(req, res).catch((err: unknown) => {
        process.stderr.write(`Message handler error: ${String(err)}\n`);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });

  process.stderr.write(
    `Octri MCP server (SSE) listening on http://${config.host}:${config.port}\n`,
  );
  process.stderr.write(
    `  SSE endpoint:  GET  /sse\n  Message relay: POST /messages?sessionId=<id>\n`,
  );
}

// ─── Stdio transport (local / Claude Desktop / Cursor) ────────────────────────

async function startStdio(config: Config): Promise<void> {
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Streamable HTTP transport (current spec, for remote hosting) ─────────────

/**
 * Serves MCP over Streamable HTTP on a single `/mcp` endpoint.
 *
 * This is the transport the spec has defined for remote servers since revision
 * 2025-03-26; the HTTP+SSE pair below it is the 2024-11-05 design it replaced
 * and is kept only so existing deployments keep working. New hosting should use
 * this one, which is what a current client tries first.
 *
 * Stateless: every request gets its own server and transport, so nothing is
 * pinned to a session id and any number of replicas can sit behind a load
 * balancer without sharing state.
 */
async function startStreamableHttp(config: Config): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    const refusal = httpRequestRefusal(req.headers, config);
    if (refusal !== null) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Forbidden: ${refusal}` }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Stateless mode answers a whole request/response cycle per POST. A GET or
    // DELETE only means anything for a session this mode never opens.
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed. This endpoint is stateless; use POST." }));
      return;
    }

    void (async (): Promise<void> => {
      const server = buildServer(config);
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        // The SDK declares this transport's `onclose` as `(() => void) | undefined`
        // while the Transport interface it implements declares `onclose?: () => void`.
        // Those describe the same thing, but `exactOptionalPropertyTypes` treats
        // them as incompatible — an inconsistency inside the SDK's own types, so
        // it is narrowed here rather than worked around in the code around it.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res);
      } catch (err: unknown) {
        process.stderr.write(`Streamable HTTP error: ${String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });

  process.stderr.write(
    `Octri MCP server (Streamable HTTP) listening on http://${config.host}:${config.port}\n` +
      `  MCP endpoint: POST /mcp\n`,
  );
}

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  if (["http", "streamable-http", "sse"].includes(config.transport)) {
    const refusal = httpStartupRefusal(config);
    if (refusal !== null) throw new Error(refusal);
  }

  if (config.transport === "http" || config.transport === "streamable-http") {
    await startStreamableHttp(config);
  } else if (config.transport === "sse") {
    await startSse(config);
  } else {
    await startStdio(config);
  }
}

/**
 * True when this module is the process entry point, rather than imported by the
 * test suite for the helpers it exports.
 *
 * `import.meta.url` is always the RESOLVED real path, while `process.argv[1]` is
 * the path as invoked, so the two diverge the moment the entry point is reached
 * through a symlink. npm and npx publish `bin` entries as exactly that
 * (`node_modules/.bin/octri-mcp -> ../@octri/mcp/dist/index.js`), so comparing
 * them raw meant `npx @octri/mcp` — the documented install, and the config every
 * client ships — started nothing and exited 0 with no output. Resolving both
 * sides keeps the symlinked shim a direct run.
 */
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry === "") return false;
  if (moduleUrl === pathToFileURL(entry).href) return true;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] need not exist on disk (bundlers, virtual filesystems).
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
