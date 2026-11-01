import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { apiFetch } from "./api-client.js";

// ─── Resources ─────────────────────────────────────────────────────────────────
//
// What the owner chose to put in front of an agent to read: the API's OpenAPI
// spec and chosen guides, served through `resources/list` and
// `resources/read`. The list rides in the manifest; the contents are read live
// from the Octri project, like the documentation tools, so a docs publish
// reaches agents without a reinstall. A server with no Octri project to read
// from (a package built without one, a project whose docs need a sign-in)
// serves none.
//
// Mirrors `McpResourceManifest` in @octri/shared (this package does not depend on it).

export interface ResourceEntry {
  slug: string;
  /** `docs://openapi.json`, `docs://guides/<section>/<guide>`. */
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  tags?: string[];
}

/** The `resources/list` entries. */
export function listResources(resources: ResourceEntry[]) {
  return resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    mimeType: resource.mimeType,
  }));
}

/** The resource a URI names, or an MCP error a client can show. */
export function findResource(resources: ResourceEntry[], uri: string): ResourceEntry {
  const resource = resources.find((r) => r.uri === uri);
  if (resource === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  return resource;
}

/** The `resources/read` result: the contents, fetched from the Octri project. */
export async function readResource(apiUrl: string, projectId: string, resource: ResourceEntry) {
  const contents = await apiFetch<{ uri: string; mimeType: string; text: string }>(
    `${apiUrl}/public/mcp/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resource.slug)}`,
  );
  return { contents: [{ uri: resource.uri, mimeType: contents.mimeType, text: contents.text }] };
}
