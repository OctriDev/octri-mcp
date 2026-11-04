import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { apiFetch } from "./api-client.js";

// ─── Tool schemas ──────────────────────────────────────────────────────────────

/**
 * Every docs tool accepts a `projectId`, but the server already knows which
 * project it serves (`--project-id` / `OCTRI_PROJECT_ID`). Marking it required
 * pushed the model to invent one, and a wrong id silently reads another
 * project, so it is advertised as the optional override it actually is.
 */
const PROJECT_ID_DESCRIPTION =
  "Project to read. Optional: defaults to the project this server was started with. Only pass it to target a different project.";

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
    description:
      "List the API's endpoints and guides, grouped by section. A large API lists its sections with endpoint counts instead: pass `section` to list one of them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        section: {
          type: "string",
          description: "Only the sections whose name contains this text",
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
          description: "The guide's group (list_endpoints shows it). Optional: found from the site's navigation when omitted.",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "get_sdk_methods",
    description:
      "Show how to call this API through its generated SDKs. With `slug` (from list_endpoints or search_docs): ready-to-use code for that endpoint in every SDK language, or in one with `language` (e.g. typescript, python, go). Without `slug`: the index of SDK methods, one line per endpoint.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description: PROJECT_ID_DESCRIPTION,
        },
        slug: {
          type: "string",
          description: "One endpoint by its slug. Omit for the index of methods.",
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

export const TOOLS: Tool[] = DOCS_TOOLS.map((tool) => ({
  ...tool,
  annotations: { title: tool.name, ...DOCS_TOOL_ANNOTATIONS },
}));

// ─── Tool: search_docs ─────────────────────────────────────────────────────────

interface SearchResult {
  slug: string;
  title: string;
  method?: string;
  path?: string;
}

export async function searchDocs(
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

interface PageContent {
  description?: string;
  parameters?: Parameter[];
  responses?: Record<string, ResponseEntry>;
  codeExamples?: CodeExample[];
}

interface DocPage extends PageContent {
  slug: string;
  title: string;
  method?: string;
  path?: string;
  /** Where the public page route keeps the generated documentation. */
  content?: PageContent | null;
}

interface PageResponse {
  page: DocPage;
  project: { name: string };
  spec: { version: string | null };
}

export function formatEndpoint(data: PageResponse): string {
  const { project, spec } = data;
  // The public page route nests the documentation under `content`; the fields
  // were once top-level, and reading only those printed a title and a path.
  const page: DocPage = { ...data.page, ...(data.page.content ?? {}) };
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

export async function getEndpoint(
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
  /** "endpoint", "guide" or "link"; a link's slug is its URL. */
  type?: string;
  method?: string;
  path?: string;
  groupSlug?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface NavTab {
  label: string;
  sections?: NavSection[];
}

export interface NavResponse {
  sections: NavSection[];
  /** A tabbed site: `sections` is only the first tab, each tab carries its own. */
  tabs?: NavTab[];
}

/**
 * Above this many endpoints a full listing costs the model more context than it
 * is worth (GitHub's 1,242 run past 100 KB), so the sections are listed with
 * their counts and `section` opens one.
 */
const FULL_LISTING_MAX_ENDPOINTS = 150;

/** Every section of the site, each tab's under its label when the site has tabs. */
function navSections(data: NavResponse): { tab: string | null; section: NavSection }[] {
  const tabs = data.tabs ?? [];
  if (tabs.length === 0) return data.sections.map((section) => ({ tab: null, section }));
  return tabs.flatMap((t) => (t.sections ?? []).map((section) => ({ tab: t.label, section })));
}

function isEndpoint(item: NavItem): boolean {
  return item.method !== undefined && item.path !== undefined;
}

function formatNavItem(item: NavItem): string {
  if (isEndpoint(item)) return `  - **${item.title}** \`${item.method} ${item.path}\` (slug: \`${item.slug}\`)`;
  // A link leaves the docs site: no tool reads it, so it carries no slug.
  if (item.type === "link") return `  - **${item.title}**: ${item.slug}`;
  const group = item.groupSlug !== undefined ? `, groupSlug: \`${item.groupSlug}\`` : "";
  return `  - **${item.title}** (guide, slug: \`${item.slug}\`${group})`;
}

export function formatNav(data: NavResponse, section: string | undefined): string {
  let sections = navSections(data).filter((s) => s.section.items.length > 0);
  const filtered = section !== undefined && section !== "";

  if (filtered) {
    const lower = section.toLowerCase();
    sections = sections.filter((s) => s.section.title.toLowerCase().includes(lower));
  }

  if (sections.length === 0) {
    return filtered ? `No section matches "${section}".` : "No endpoints found.";
  }

  const total = sections.reduce((n, s) => n + s.section.items.filter(isEndpoint).length, 0);
  const compact = !filtered && total > FULL_LISTING_MAX_ENDPOINTS;

  let lastTab: string | null = null;
  const blocks = sections.map(({ tab, section: s }) => {
    const heading = tab !== null && tab !== lastTab ? `## ${tab}\n\n` : "";
    lastTab = tab;
    const endpoints = s.items.filter(isEndpoint);
    // Compact: an endpoint section becomes one line; guides and links stay, they are few.
    const shown = compact ? s.items.filter((i) => !isEndpoint(i)) : s.items;
    const lines = shown.map(formatNavItem);
    if (compact && endpoints.length > 0) lines.push(`  - ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`);
    return `${heading}### ${s.title}\n${lines.join("\n")}`;
  });

  const lead = compact
    ? `${total} endpoints, too many to list at once. Pass \`section\` with a section name below to list its endpoints, or use search_docs.\n\n`
    : "";
  return lead + blocks.join("\n\n");
}

async function fetchNav(apiUrl: string, projectId: string): Promise<NavResponse> {
  return apiFetch<NavResponse>(`${apiUrl}/public/docs/${encodeURIComponent(projectId)}/nav`);
}

export async function listEndpoints(
  apiUrl: string,
  projectId: string,
  section: string | undefined,
): Promise<string> {
  return formatNav(await fetchNav(apiUrl, projectId), section);
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

export async function getChangelog(
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

export async function listSdks(apiUrl: string, projectId: string): Promise<string> {
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

export async function getGuide(
  apiUrl: string,
  projectId: string,
  slug: string,
  groupSlug: string | undefined,
): Promise<string> {
  const pid = encodeURIComponent(projectId);
  // A guide in a group is only served under its group, and models rarely pass
  // one: the navigation says which group a slug belongs to.
  const group =
    groupSlug !== undefined && groupSlug !== ""
      ? groupSlug
      : navSections(await fetchNav(apiUrl, projectId))
          .flatMap((s) => s.section.items)
          .find((i) => i.type === "guide" && i.slug === slug)?.groupSlug;
  const path =
    group !== undefined
      ? `${apiUrl}/public/docs/${pid}/guides/${encodeURIComponent(group)}/${encodeURIComponent(slug)}`
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
      // No method name in the heading: `methodName` is the flat generator name
      // (`apiKeysList`), not the call the SDK exposes (`client.apiKeys.list()`),
      // which the code below shows.
      return `## ${ep.title}\n\`${id}\`\n\n${blocks}`;
    })
    .join("\n\n---\n\n");
}

export async function getSdkMethods(
  apiUrl: string,
  projectId: string,
  slug: string | undefined,
  language: string | undefined,
): Promise<string> {
  const params = new URLSearchParams();
  if (slug !== undefined && slug !== "") params.set("slug", slug);
  if (language !== undefined && language !== "") params.set("language", language);
  const index = slug === undefined || slug === "";
  // The index prints no code, so one language's snippets are all it needs to
  // fetch: every language of every endpoint ran past a megabyte for Twilio.
  if (index && !params.has("language")) params.set("language", "typescript");
  const qs = params.toString();
  const url = `${apiUrl}/public/sdk/${encodeURIComponent(projectId)}/methods${qs !== "" ? `?${qs}` : ""}`;

  const data = await apiFetch<SdkMethodsResponse>(url);
  return index ? formatSdkMethodIndex(data) : formatSdkMethods(data, slug);
}

/** The API's own cap on endpoints per methods response. */
const SDK_METHODS_PAGE = 200;

export function formatSdkMethodIndex(data: SdkMethodsResponse): string {
  if (data.endpoints.length === 0) return "No SDK methods are available for this project yet.";
  const rows = data.endpoints.map((ep) => {
    const id = `${ep.method ?? ""} ${ep.path ?? ""}`.trim();
    return `- **${ep.title}**${id !== "" ? ` \`${id}\`` : ""} (slug: \`${ep.slug}\`)`;
  });
  const more =
    data.endpoints.length >= SDK_METHODS_PAGE
      ? `\n\nThe first ${SDK_METHODS_PAGE} endpoints by path. Use search_docs to find the slug of any other.`
      : "";
  return `${rows.join("\n")}\n\nPass \`slug\` to get the code for one endpoint in every SDK language.${more}`;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────────

/** True for one of the seven documentation tools every server carries. */
export function isDocsTool(name: string): boolean {
  return TOOLS.some((t) => t.name === name);
}

/**
 * Runs one documentation tool against the Octri API and returns its text.
 * Callers check `isDocsTool` first; an unknown name is a programming error.
 */
export async function runDocsTool(
  name: string,
  a: Record<string, unknown>,
  apiUrl: string,
  projectId: string,
): Promise<string> {
  switch (name) {
    case "search_docs": {
      const query = typeof a["query"] === "string" ? a["query"] : "";
      const limit = typeof a["limit"] === "number" ? a["limit"] : 5;
      return searchDocs(apiUrl, projectId, query, limit);
    }
    case "get_endpoint": {
      const slug = typeof a["slug"] === "string" ? a["slug"] : "";
      return getEndpoint(apiUrl, projectId, slug);
    }
    case "list_endpoints": {
      const section = typeof a["section"] === "string" ? a["section"] : undefined;
      return listEndpoints(apiUrl, projectId, section);
    }
    case "get_changelog":
      return getChangelog(apiUrl, projectId, a["breakingOnly"] === true);
    case "list_sdks":
      return listSdks(apiUrl, projectId);
    case "get_guide": {
      const slug = typeof a["slug"] === "string" ? a["slug"] : "";
      const groupSlug = typeof a["groupSlug"] === "string" ? a["groupSlug"] : undefined;
      return getGuide(apiUrl, projectId, slug, groupSlug);
    }
    case "get_sdk_methods": {
      const slug = typeof a["slug"] === "string" ? a["slug"] : undefined;
      const lang = typeof a["language"] === "string" ? a["language"] : undefined;
      return getSdkMethods(apiUrl, projectId, slug, lang);
    }
    default:
      throw new Error(`Not a documentation tool: ${name}`);
  }
}
