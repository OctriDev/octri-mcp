import { changesForGroup } from "./changes.js";
import type { McpToolsResponse } from "./operations.js";

// ─── Tool groups ───────────────────────────────────────────────────────────────
//
// An owner can publish named slices of a project's tools ("billing",
// "read-only"), each served as its own MCP server: `--group billing`, or a
// group's hosted URL. The Octri API resolves membership and ships it as
// endpoint slugs, so serving a group is only a filter. Names, permissions and
// pins are the project's own, so a group can take tools away but never change
// one: an `off` tool is in no group, and an "ask first" tool still asks.
//
// Mirrors `McpToolGroupManifest` in @octri/shared (this package does not depend on it).

export interface ToolGroup {
  slug: string;
  name: string;
  description?: string;
  /** Whether the documentation tools are listed on this group's server. */
  docs: boolean;
  /** Endpoint slugs of the member tools. */
  tools: string[];
  /** Slugs of the member chained tools, prompts and resources. Absent: none. */
  chains?: string[];
  prompts?: string[];
  resources?: string[];
}

/** A group the project does not have. The server then serves no tools at all. */
export class UnknownGroupError extends Error {
  constructor(readonly group: string, readonly known: string[]) {
    super(
      `This project has no tool group "${group}".` +
        (known.length > 0 ? ` Its groups: ${known.join(", ")}.` : " It has no tool groups."),
    );
    this.name = "UnknownGroupError";
  }
}

/**
 * The manifest as one group's server sees it: the member tools only, and that
 * group as the one entry under `groups`. Narrowing an already narrowed
 * manifest by the same group returns the same list.
 */
export function narrowToGroup(manifest: McpToolsResponse, slug: string): McpToolsResponse {
  const groups = manifest.groups ?? [];
  const group = groups.find((g) => g.slug === slug);
  if (group === undefined) throw new UnknownGroupError(slug, groups.map((g) => g.slug));
  const members = new Set(group.tools);
  // A group from before chained tools, prompts and resources lists none, so it
  // never gains items it was not published with.
  const keep = <T extends { slug: string }>(items: T[] | undefined, slugs: string[] | undefined) => {
    const picked = new Set(slugs ?? []);
    return (items ?? []).filter((item) => picked.has(item.slug));
  };
  return {
    ...manifest,
    tools: manifest.tools.filter((t) => members.has(t.slug)),
    groups: [group],
    chains: keep(manifest.chains, group.chains),
    prompts: keep(manifest.prompts, group.prompts),
    resources: keep(manifest.resources, group.resources),
    // What changed for this group only: a tool that left it is gone to its agents.
    ...(manifest.changes !== undefined ? { changes: changesForGroup(manifest.changes, slug) } : {}),
  };
}

/** The group a narrowed manifest serves, if it was narrowed. */
export function servedGroup(manifest: McpToolsResponse, slug: string | undefined): ToolGroup | undefined {
  return slug === undefined ? undefined : manifest.groups?.find((g) => g.slug === slug);
}
