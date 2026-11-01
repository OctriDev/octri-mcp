import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "./core.js";
import { credentialSecrets, REDACTED, redactSecrets } from "./redact.js";

import type { OperationTool, ToolManifest } from "./core.js";

const env = (vars: Record<string, string>) => ({ prefix: "OCTRI", vars });

describe("credentialSecrets", () => {
  it("collects every form a key, token or password could come back in", () => {
    const secrets = credentialSecrets(env({ OCTRI_API_KEY: "sk/live+key=1", OCTRI_API_KEY_HEADER: "X-Api-Key" }));
    assert.ok(secrets.includes("sk/live+key=1"));
    assert.ok(secrets.includes(encodeURIComponent("sk/live+key=1")));
    assert.ok(!secrets.includes("X-Api-Key"), "the header name is not a secret");
  });

  it("includes the Basic header value, not the username alone", () => {
    const secrets = credentialSecrets(env({ OCTRI_API_USERNAME: "moe", OCTRI_API_PASSWORD: "hunter2hunter2" }));
    assert.ok(secrets.includes(Buffer.from("moe:hunter2hunter2").toString("base64")));
    assert.ok(secrets.includes("hunter2hunter2"));
    assert.ok(!secrets.includes("moe"));
  });

  it("leaves values too short to replace safely alone", () => {
    assert.deepEqual(credentialSecrets(env({ OCTRI_API_TOKEN: "abc" })).filter((s) => s === "abc"), []);
  });

  it("is empty without credentials", () => {
    assert.deepEqual(credentialSecrets(env({})), []);
  });
});

describe("redactSecrets", () => {
  const secrets = credentialSecrets(env({ OCTRI_API_TOKEN: "tok_1234567890abcdef" }));

  it("replaces every occurrence", () => {
    const text = 'Invalid token "tok_1234567890abcdef". Bearer tok_1234567890abcdef';
    assert.equal(redactSecrets(text, secrets), `Invalid token "${REDACTED}". Bearer ${REDACTED}`);
  });

  it("takes out the start of a secret cut off by the size limit", () => {
    const text = '{"echo":"tok_123456\n(truncated at 65536 bytes)';
    assert.equal(redactSecrets(text, secrets), `{"echo":"${REDACTED}\n(truncated at 65536 bytes)`);
  });

  it("leaves text without credentials as it is", () => {
    assert.equal(redactSecrets("nothing here", secrets), "nothing here");
  });
});

describe("a server whose API echoes its credential", () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/refuse") {
      res.statusCode = 401;
      res.end(`{"error":"key ${String(req.headers["x-api-key"])} is not valid"}`);
      return;
    }
    res.end(JSON.stringify({ headers: req.headers }));
  });
  let manifest: ToolManifest;

  const tool = (name: string, policy: NonNullable<OperationTool["policy"]>): OperationTool => ({
    slug: name,
    name,
    description: name,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method: "GET", path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy,
  });

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    manifest = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: "apiKey",
      tools: [tool("headers", "auto"), tool("refuse", "auto"), tool("ask", "confirm")],
    };
  });

  after(() => {
    upstream.close();
  });

  const KEY = "owner-stored-key-9f8e7d6c";

  async function connect(onAsk?: (message: string) => void): Promise<Client> {
    const server = createServer({
      source: { kind: "static", manifest },
      env: env({ OCTRI_API_KEY: KEY, OCTRI_API_KEY_HEADER: "X-Api-Key" }),
    });
    const client = new Client({ name: "redact-test", version: "1" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      onAsk?.(request.params.message);
      return { action: "accept", content: {} };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { text: string }[])[0]?.text ?? "";

  it("sends the key but never hands it back to the agent", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "headers", arguments: {} });
    assert.ok(text(result).includes(`"x-api-key":"${REDACTED}"`));
    assert.ok(!text(result).includes(KEY));
    await client.close();
  });

  it("takes the key out of an error the API wrote around it", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "refuse", arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes(`key ${REDACTED} is not valid`));
    assert.ok(!text(result).includes(KEY));
    await client.close();
  });

  it("still asks before an ask-first tool, with nothing secret in the prompt", async () => {
    const asked: string[] = [];
    const client = await connect((message) => asked.push(message));
    const result = await client.callTool({ name: "ask", arguments: {} });
    assert.equal(asked.length, 1);
    assert.ok(!asked[0]?.includes(KEY));
    assert.ok(!text(result).includes(KEY));
    await client.close();
  });
});
