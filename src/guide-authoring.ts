import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// =============================================================================
// Guide authoring: tools that write a project's guides through the Octri API.
//
// Only a host that knows who is calling turns these on: Octri's hosted server
// does it for a team installation, where a teammate signed in with Octri, and
// passes a project-scoped API key minted for that teammate. The key acts as
// their membership, so the API refuses what their role could not do in the
// dashboard. A self-hosted server never has one, so it never lists these.
//
// Same names and arguments as the Octri CLI's MCP server.
// =============================================================================

export interface GuideAuthoring {
  /** A project-scoped Octri API key, sent as `X-API-Key`. */
  apiKey: string;
  /** Whether octri_publish_guide is offered: the caller may publish. */
  publish: boolean;
}

const READ_TOOLS: Tool[] = [
  {
    name: "octri_list_guides",
    description: "The project's guides, drafted and published, with their ids.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "octri_get_guide",
    description: "One guide with its draft content.",
    inputSchema: { type: "object", properties: { guide_id: { type: "string" } }, required: ["guide_id"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const WRITE_TOOLS: Tool[] = [
  {
    name: "octri_create_guide",
    description:
      "Create a guide from scratch as an unpublished draft. `body_mdx` is the page in MDX; `slug` is its URL segment (lowercase letters, digits, hyphens). Readers see nothing until it is published.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        slug: { type: "string" },
        body_mdx: { type: "string" },
        group_id: { type: "string", description: "The guide group it sits in, from octri_list_guides. Omit for none." },
      },
      required: ["title", "slug", "body_mdx"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "octri_update_guide",
    description: "Save changes to a guide's draft: its title, slug or MDX body. Readers see them once the guide is published.",
    inputSchema: {
      type: "object",
      properties: {
        guide_id: { type: "string" },
        title: { type: "string" },
        slug: { type: "string" },
        body_mdx: { type: "string" },
      },
      required: ["guide_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const PUBLISH_TOOL: Tool = {
  name: "octri_publish_guide",
  description: "Publish one guide's draft. Readers see it at once.",
  inputSchema: { type: "object", properties: { guide_id: { type: "string" } }, required: ["guide_id"] },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

/** The tools a caller gets: reads always, writes unless the session may not write, publish when allowed. */
export function guideTools(authoring: GuideAuthoring, canWrite: boolean): Tool[] {
  if (!canWrite) return READ_TOOLS;
  return [...READ_TOOLS, ...WRITE_TOOLS, ...(authoring.publish ? [PUBLISH_TOOL] : [])];
}

export function isGuideTool(tools: readonly Tool[], name: string): boolean {
  return tools.some((t) => t.name === name);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function stringArg(a: Record<string, unknown>, key: string): string {
  const value = a[key];
  if (typeof value !== "string" || value === "") throw new Error(`\`${key}\` is required.`);
  return value;
}

/** A guide id goes into the request path, so only a plain id is accepted. */
function guideId(a: Record<string, unknown>): string {
  const id = stringArg(a, "guide_id");
  if (!SAFE_ID.test(id)) throw new Error("`guide_id` must be a guide id from octri_list_guides.");
  return id;
}

/**
 * Runs one guide tool and returns its JSON as text. The API's own error
 * message is passed on ("A guide with that slug exists in this group."), since
 * it says which argument to change.
 */
export async function runGuideTool(
  name: string,
  a: Record<string, unknown>,
  apiUrl: string,
  projectId: string,
  authoring: GuideAuthoring,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = `${apiUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}/guides`;
  const call = async (path: string, method: string, body?: unknown): Promise<string> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-API-Key": authoring.apiKey },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `The Octri API returned HTTP ${res.status}.`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === "string") message = parsed.error.message;
      } catch {
        // Not JSON: keep the status line.
      }
      throw new Error(message);
    }
    return text;
  };

  switch (name) {
    case "octri_list_guides":
      return call("", "GET");
    case "octri_get_guide":
      return call(`/${guideId(a)}`, "GET");
    case "octri_create_guide":
      return call("", "POST", {
        title: stringArg(a, "title"),
        slug: stringArg(a, "slug"),
        // An empty body is a real start: the title alone, filled in later.
        bodyMdx: typeof a["body_mdx"] === "string" ? a["body_mdx"] : "",
        ...(typeof a["group_id"] === "string" && a["group_id"] !== "" ? { groupId: a["group_id"] } : {}),
        published: false,
      });
    case "octri_update_guide": {
      const changes = {
        ...(typeof a["title"] === "string" && a["title"] !== "" ? { title: a["title"] } : {}),
        ...(typeof a["slug"] === "string" && a["slug"] !== "" ? { slug: a["slug"] } : {}),
        ...(typeof a["body_mdx"] === "string" ? { bodyMdx: a["body_mdx"] } : {}),
      };
      if (Object.keys(changes).length === 0) throw new Error("Name at least one of `title`, `slug` or `body_mdx` to change.");
      return call(`/${guideId(a)}`, "PATCH", changes);
    }
    case "octri_publish_guide":
      if (!authoring.publish) throw new Error("Publishing guides needs the publish permission.");
      return call(`/${guideId(a)}/publish`, "POST", {});
    default:
      throw new Error(`Unknown guide tool ${name}.`);
  }
}
