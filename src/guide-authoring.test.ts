import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, noUserLimits } from "./core.js";

import type { CreateServerOptions } from "./core.js";

// The guide tools a hosted team session gets, against a stand-in Octri API.

describe("guide authoring tools", () => {
  const seen: { method: string; url: string; key: string | undefined; body: string }[] = [];
  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (body.includes('"slug":"taken"')) {
        res.statusCode = 409;
        res.end('{"error":{"code":"SLUG_TAKEN","message":"A guide with that slug exists in this group."}}');
        return;
      }
      res.end('{"guide":{"id":"g1"}}');
    });
  });
  let apiUrl = "";

  before(async () => {
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address !== null && typeof address !== "string");
    apiUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  after(() => {
    api.close();
  });

  async function connect(options: Partial<CreateServerOptions>): Promise<Client> {
    const server = createServer({
      source: {
        kind: "static",
        manifest: { baseUrl: "https://api.example.com", auth: "none", tools: [] },
        octri: { apiUrl, projectId: "p1", docs: false },
      },
      ...options,
    });
    const client = new Client({ name: "guide-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

  it("lists nothing without a key, as a self-hosted server", async () => {
    const client = await connect({});
    assert.deepEqual(await names(client), []);
    await client.close();
  });

  it("offers create and edit, and publish only when the caller may publish", async () => {
    const editor = await connect({ guides: { apiKey: "ifk_project", publish: false } });
    assert.deepEqual(await names(editor), ["octri_list_guides", "octri_get_guide", "octri_create_guide", "octri_update_guide"]);
    await editor.close();

    const publisher = await connect({ guides: { apiKey: "ifk_project", publish: true } });
    assert.ok((await names(publisher)).includes("octri_publish_guide"));
    await publisher.close();
  });

  it("keeps a read-only session to the reads", async () => {
    const client = await connect({
      guides: { apiKey: "ifk_project", publish: true },
      permissions: { ...noUserLimits(), readOnly: true },
    });
    assert.deepEqual(await names(client), ["octri_list_guides", "octri_get_guide"]);
    await client.close();
  });

  it("creates a draft with the session's project key", async () => {
    const client = await connect({ guides: { apiKey: "ifk_project", publish: false } });
    const result = await client.callTool({
      name: "octri_create_guide",
      arguments: { title: "Quickstart", slug: "quickstart", body_mdx: "# Hello" },
    });
    assert.notEqual(result.isError, true);
    const sent = seen.at(-1)!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.url, "/api/v1/projects/p1/guides");
    assert.equal(sent.key, "ifk_project");
    assert.deepEqual(JSON.parse(sent.body), { title: "Quickstart", slug: "quickstart", bodyMdx: "# Hello", published: false });
    await client.close();
  });

  it("passes the API's reason on, and refuses an id that would change the path", async () => {
    const client = await connect({ guides: { apiKey: "ifk_project", publish: true } });
    const clash = await client.callTool({
      name: "octri_create_guide",
      arguments: { title: "Again", slug: "taken", body_mdx: "" },
    });
    assert.equal(clash.isError, true);
    assert.match((clash.content as { text: string }[])[0]?.text ?? "", /slug exists in this group/);

    const before = seen.length;
    const sneaky = await client.callTool({ name: "octri_publish_guide", arguments: { guide_id: "g1/../../x" } });
    assert.equal(sneaky.isError, true);
    assert.equal(seen.length, before);
    await client.close();
  });
});
