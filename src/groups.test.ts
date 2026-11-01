import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer, loadConfig, loadUserPermissions, narrowToGroup, runDoctor, UnknownGroupError, UsageReporter } from "./core.js";

import type { CreateServerOptions, OperationTool, ToolManifest } from "./core.js";

// Tool groups: one project's tools served as several smaller servers. The API
// resolves membership into the manifest; the server only filters by it, so a
// group can take tools away but never loosen what the owner published.

function tool(name: string, method: string, policy: NonNullable<OperationTool["policy"]>): OperationTool {
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy,
  };
}

describe("narrowToGroup", () => {
  const manifest: ToolManifest = {
    baseUrl: "https://api.test",
    auth: "none",
    tools: [tool("a", "GET", "auto"), tool("b", "POST", "confirm"), tool("c", "GET", "auto")],
    groups: [
      { slug: "billing", name: "Billing", docs: true, tools: ["slug-a", "slug-b"] },
      { slug: "reads", name: "Reads", docs: false, tools: ["slug-c"] },
    ],
  };

  it("keeps the member tools and only that group, and is stable when repeated", () => {
    const narrowed = narrowToGroup(manifest, "billing");
    assert.deepEqual(narrowed.tools.map((t) => t.name), ["a", "b"]);
    assert.deepEqual(narrowed.groups?.map((g) => g.slug), ["billing"]);
    assert.deepEqual(narrowToGroup(narrowed, "billing"), narrowed);
  });

  it("throws for a group the project does not have, naming the ones it does", () => {
    assert.throws(() => narrowToGroup(manifest, "admin"), (err: unknown) => {
      assert.ok(err instanceof UnknownGroupError);
      assert.match(err.message, /no tool group "admin"\. Its groups: billing, reads\./);
      return true;
    });
    assert.throws(() => narrowToGroup({ baseUrl: manifest.baseUrl, auth: manifest.auth, tools: manifest.tools }, "billing"), /has no tool groups/);
  });
});

describe("loadConfig --group", () => {
  it("reads the flag, then the prefixed variable, and ignores a blank one", () => {
    assert.equal(loadConfig(["--group", "billing"], { prefix: "OCTRI", vars: { OCTRI_GROUP: "x" } }).group, "billing");
    assert.equal(loadConfig([], { prefix: "ACME", vars: { ACME_GROUP: " reads " } }).group, "reads");
    assert.equal(loadConfig([], { prefix: "OCTRI", vars: { OCTRI_GROUP: " " } }).group, undefined);
  });
});

describe("createServer serving one group", () => {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  let manifest: ToolManifest;
  const octri = { apiUrl: "https://api.test/api/v1", projectId: "p1" };

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    // An `off` tool never reaches a served manifest, so it is in no group's
    // list either; `refund` asks first; `listUsers` is outside billing.
    manifest = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: "none",
      tools: [tool("listInvoices", "GET", "auto"), tool("refund", "POST", "confirm"), tool("listUsers", "GET", "auto")],
      groups: [
        { slug: "billing", name: "Billing", docs: true, tools: ["slug-listInvoices", "slug-refund", "slug-deleted"] },
        { slug: "users", name: "Users", docs: false, tools: ["slug-listUsers"] },
      ],
    };
  });

  after(() => {
    upstream.close();
  });

  async function connect(options: Partial<CreateServerOptions>, approval?: "accept" | "decline"): Promise<Client> {
    const server = createServer({
      source: { kind: "static", manifest, octri },
      env: { prefix: "OCTRI", vars: {} },
      ...options,
    });
    const client = new Client(
      { name: "groups-test", version: "1" },
      { capabilities: approval === undefined ? {} : { elicitation: {} } },
    );
    if (approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async () => ({ action: approval, content: {} }));
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { text: string }[])[0]?.text ?? "";

  it("lists only the group's operation tools, beside the docs tools", async () => {
    const client = await connect({ group: "billing" });
    const listed = await names(client);
    assert.ok(listed.includes("search_docs"));
    assert.deepEqual(listed.filter((n) => !n.includes("_")), ["listInvoices", "refund"]);
    await client.close();
  });

  it("refuses a tool outside the group as unknown, and sends nothing", async () => {
    const client = await connect({ group: "billing" });
    const before = seen.length;
    const result = await client.callTool({ name: "listUsers", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(text(result), "Unknown tool: listUsers");
    assert.equal(seen.length, before);
    await client.close();
  });

  it("still asks before an ask-first tool inside a group", async () => {
    const declining = await connect({ group: "billing" }, "decline");
    const before = seen.length;
    const declined = await declining.callTool({ name: "refund", arguments: {} });
    assert.match(text(declined), /declined/i);
    assert.equal(seen.length, before);
    await declining.close();

    const approving = await connect({ group: "billing" }, "accept");
    assert.notEqual((await approving.callTool({ name: "refund", arguments: {} })).isError, true);
    assert.equal(seen.at(-1), "POST /refund");
    await approving.close();
  });

  it("applies the user's own limits inside the group", async () => {
    const readOnly = await connect({ group: "billing", permissions: loadUserPermissions(["--read-only"], {}) });
    assert.deepEqual((await names(readOnly)).filter((n) => !n.includes("_")), ["listInvoices"]);
    await readOnly.close();

    const denied = await connect({ group: "billing", permissions: loadUserPermissions(["--deny-tools", "listInvoices"], {}) });
    assert.deepEqual((await names(denied)).filter((n) => !n.includes("_")), ["refund"]);
    await denied.close();

    const dry = await connect({ group: "billing", permissions: loadUserPermissions(["--dry-run"], {}) });
    const before = seen.length;
    assert.match(text(await dry.callTool({ name: "listInvoices", arguments: {} })), /GET http:\/\/127\.0\.0\.1:\d+\/listInvoices/);
    assert.equal(seen.length, before);
    await dry.close();
  });

  it("leaves the docs tools out of a group that switched them off", async () => {
    const client = await connect({ group: "users" });
    assert.deepEqual(await names(client), ["listUsers"]);
    const result = await client.callTool({ name: "search_docs", arguments: { query: "x" } });
    assert.equal(text(result), "Unknown tool: search_docs");
    await client.close();
  });

  it("serves nothing for a group the project does not have", async () => {
    const client = await connect({ group: "admin" });
    assert.deepEqual(await names(client), []);
    const result = await client.callTool({ name: "listInvoices", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /no tool group "admin"/);
    await client.close();
  });

  it("reports each call with the group it came through", async () => {
    const sent: string[] = [];
    const reporter = new UsageReporter(octri.apiUrl, async (_url, body) => {
      sent.push(body);
    });
    const client = await connect({ group: "billing", reporter });
    await client.callTool({ name: "listInvoices", arguments: {} });
    await reporter.flush();
    assert.match(sent[0] ?? "", /"tool":"listInvoices","slug":"slug-listInvoices","group":"billing","outcome":"ok"/);
    await client.close();
  });

  it("doctor checks the group and counts only its tools", async () => {
    const env = { prefix: "OCTRI", vars: {} };
    const ok = await runDoctor({
      source: { kind: "static", manifest },
      env,
      permissions: loadUserPermissions([], {}),
      telemetry: false,
      call: false,
      group: "billing",
    });
    assert.ok(ok.some((c) => c.name === "Tool group" && c.status === "pass" && c.detail === "billing: 2 tools"));
    const missing = await runDoctor({
      source: { kind: "static", manifest },
      env,
      permissions: loadUserPermissions([], {}),
      telemetry: false,
      call: false,
      group: "admin",
    });
    assert.equal(missing.at(-1)?.status, "fail");
    assert.match(missing.at(-1)?.detail ?? "", /no tool group "admin".*--group \/ OCTRI_GROUP/);
  });
});
