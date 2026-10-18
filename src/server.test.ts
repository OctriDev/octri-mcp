import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer, loadUserPermissions, UsageReporter } from "./core.js";

import type { CreateServerOptions, OperationTool, ToolManifest } from "./core.js";

// A server built from a static manifest is what a package published under a
// customer's own name runs: no Octri API to list tools from, the customer's own
// env prefix, the customer's server name. These run it in-process over the
// SDK's in-memory transport against a local upstream.

function tool(name: string, method: string, policy: NonNullable<OperationTool["policy"]>): OperationTool {
  return {
    slug: name,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy,
  };
}

describe("createServer with a static manifest", () => {
  const seen: { method: string; url: string; authorization: string | undefined }[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  let manifest: ToolManifest;

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    manifest = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: "bearer",
      tools: [tool("listPets", "GET", "auto"), tool("deletePet", "DELETE", "confirm")],
    };
  });

  after(() => {
    upstream.close();
  });

  async function connect(
    options: Partial<CreateServerOptions>,
    approval?: "accept" | "decline",
  ): Promise<Client> {
    const server = createServer({
      source: { kind: "static", manifest },
      branding: { name: "acme-mcp", version: "2.4.0" },
      env: { prefix: "ACME", vars: { ACME_API_TOKEN: "acme-secret" } },
      ...options,
    });
    const client = new Client(
      { name: "server-test", version: "1" },
      { capabilities: approval === undefined ? {} : { elicitation: {} } },
    );
    if (approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async () => ({ action: approval, content: {} }));
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { text: string }[])[0]?.text ?? "";

  it("lists the manifest's tools under the customer's name, without Octri's docs tools", async () => {
    const client = await connect({});
    assert.equal(client.getServerVersion()?.name, "acme-mcp");
    assert.equal(client.getServerVersion()?.version, "2.4.0");
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), ["listPets", "deletePet"]);
    assert.equal(tools[1]?.annotations?.destructiveHint, true);
    await client.close();
  });

  it("calls the API with credentials read under the customer's prefix", async () => {
    const client = await connect({});
    const before = seen.length;
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(seen.length, before + 1);
    assert.deepEqual(seen.at(-1), { method: "GET", url: "/listPets", authorization: "Bearer acme-secret" });
    await client.close();
  });

  it("asks before an ask-first tool, and names the customer's variable when it cannot", async () => {
    const refused = await connect({});
    const before = seen.length;
    const blocked = await refused.callTool({ name: "deletePet", arguments: {} });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /ACME_ALLOW_TOOLS=deletePet/);
    assert.equal(seen.length, before);
    await refused.close();

    const approving = await connect({}, "accept");
    const sent = await approving.callTool({ name: "deletePet", arguments: {} });
    assert.notEqual(sent.isError, true);
    assert.equal(seen.at(-1)?.method, "DELETE");
    await approving.close();
  });

  it("applies the user's limits from the customer's prefix", async () => {
    const env = { prefix: "ACME", vars: { ACME_API_TOKEN: "acme-secret", ACME_READ_ONLY: "1" } };
    const client = await connect({ env, permissions: loadUserPermissions([], env) });
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["listPets"]);
    await client.close();
  });

  it("answers an unknown tool as unknown", async () => {
    const client = await connect({});
    const result = await client.callTool({ name: "search_docs", arguments: { query: "pets" } });
    assert.equal(result.isError, true);
    assert.equal(text(result), "Unknown tool: search_docs");
    await client.close();
  });

  it("serves docs tools and reports calls only when given an Octri project", async () => {
    const sent: { url: string; body: string }[] = [];
    const reporter = new UsageReporter("https://api.test/api/v1", async (url, body) => {
      sent.push({ url, body });
    });
    const client = await connect({
      source: { kind: "static", manifest, octri: { apiUrl: "https://api.test/api/v1", projectId: "p1" } },
      reporter,
    });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("search_docs"));
    assert.ok(names.includes("listPets"));

    await client.callTool({ name: "listPets", arguments: {} });
    await reporter.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, "https://api.test/api/v1/public/mcp/p1/events");
    assert.match(sent[0]?.body ?? "", /"tool":"listPets","outcome":"ok"/);
    await client.close();
  });
});
