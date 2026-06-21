#!/usr/bin/env node

/**
 * Octri MCP Server
 *
 * Exposes API documentation as MCP tools so AI assistants (Claude, Cursor, etc.)
 * can search, retrieve, and navigate your Octri project docs.
 *
 * Transports:
 *   stdio (default) — for Claude Desktop / Cursor local integrations
 *   sse             — for remote hosting via Docker (MCP_TRANSPORT=sse)
 */

import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.octri.dev/api/v1";

interface Config {
  projectId: string;
  apiUrl: string;
  transport: string;
  port: number;
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
  };
}

// ─── API client ────────────────────────────────────────────────────────────────

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
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Tool schemas ──────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
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
          description: "The project to search",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
      },
      required: ["query", "projectId"],
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
          description: "The project ID",
        },
        slug: {
          type: "string",
          description: "The endpoint slug",
        },
      },
      required: ["projectId", "slug"],
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
          description: "The project ID",
        },
        section: {
          type: "string",
          description: "Filter by section/tag name",
        },
      },
      required: ["projectId"],
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
          description: "The project ID",
        },
        breakingOnly: {
          type: "boolean",
          description: "Only return entries with breaking changes (default false)",
        },
      },
      required: ["projectId"],
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
          description: "The project ID",
        },
      },
      required: ["projectId"],
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
          description: "The project ID",
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
      required: ["projectId", "slug"],
    },
  },
  {
    name: "get_sdk_methods",
    description:
      "Show how to call this API through its generated SDKs — ready-to-use code snippets per endpoint in every supported language. Use `slug` (from list_endpoints) to focus on one endpoint, and `language` (e.g. typescript, python, go) to focus on one language.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: "The project ID",
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
      required: ["projectId"],
    },
  },
];

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
          ? ` — \`${r.method} ${r.path}\``
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
        const desc = resp.description !== undefined ? ` — ${resp.description}` : "";
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
          return `  - **${item.title}**${badge} — slug: \`${item.slug}\``;
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
}

function formatChangelog(
  entries: ChangelogEntry[],
  breakingOnly: boolean,
): string {
  const subset = breakingOnly
    ? entries.filter((e) => e.hasBreakingChanges).slice(0, 3)
    : entries.slice(0, 3);

  if (subset.length === 0) {
    return breakingOnly
      ? "No breaking changes found in recent history."
      : "No changelog entries found.";
  }

  return subset
    .map((entry) => {
      const date = new Date(entry.generatedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const breakingTag = entry.hasBreakingChanges
        ? " — **Breaking changes**"
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
}

async function getChangelog(
  apiUrl: string,
  projectId: string,
  breakingOnly: boolean,
): Promise<string> {
  const data = await apiFetch<ChangelogListResponse>(
    `${apiUrl}/public/changelog/${encodeURIComponent(projectId)}`,
  );
  return formatChangelog(data.changelogs, breakingOnly);
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
    .map((b) => `- **${b.lang}** — v${b.version} — download: ${b.downloadUrl}`)
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
      return `## ${ep.title} — \`${ep.methodName}()\`\n\`${id}\`\n\n${blocks}`;
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

// ─── MCP server factory ────────────────────────────────────────────────────────

function buildServer(config: Config): Server {
  const server = new Server(
    { name: "@octri/mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

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

async function startSse(config: Config): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${config.port}`,
    );

    // GET /sse — open a new SSE connection
    if (req.method === "GET" && url.pathname === "/sse") {
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

    // POST /messages?sessionId=X — forward client message to the right session
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
    httpServer.listen(config.port, resolve);
  });

  process.stderr.write(
    `Octri MCP server (SSE) listening on http://0.0.0.0:${config.port}\n`,
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

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.transport === "sse") {
    await startSse(config);
  } else {
    await startStdio(config);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
