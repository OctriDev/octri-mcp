import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./core.js";
import { runLogin, runLogout, withKeychainCredential } from "./keychain.js";

import type { CredentialStore, LoginIo } from "./keychain.js";
import type { ToolManifest } from "./core.js";

// The system keychain stood in for by a map: what login saves, what the
// server reads back at start, and that env vars still win.

function memoryStore(): CredentialStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    service: "test-mcp",
    entries,
    read: async (account) => entries.get(account) ?? null,
    write: async (account, value) => {
      entries.set(account, value);
    },
    remove: async (account) => entries.delete(account),
  };
}

function answering(...answers: string[]): LoginIo & { asked: { question: string; hidden: boolean }[]; out: string } {
  const io = {
    asked: [] as { question: string; hidden: boolean }[],
    out: "",
    ask: async (question: string, hidden: boolean) => {
      io.asked.push({ question, hidden });
      return answers.shift() ?? "";
    },
    write: (text: string) => {
      io.out += text;
    },
  };
  return io;
}

describe("withKeychainCredential", () => {
  it("adds the stored credential under the server's own prefix when the env has none", async () => {
    const store = memoryStore();
    store.entries.set("default", JSON.stringify({ API_KEY: "sk_from_keychain", API_KEY_HEADER: "X-Acme-Key" }));
    const env = { prefix: "ACME", vars: { PATH: "/bin" } };
    const result = await withKeychainCredential(env, "default", store);
    assert.equal(result.source, "keychain");
    assert.equal(result.env.vars.ACME_API_KEY, "sk_from_keychain");
    assert.equal(result.env.vars.ACME_API_KEY_HEADER, "X-Acme-Key");
    assert.equal(result.env.vars.PATH, "/bin");
    assert.equal((env.vars as Record<string, string>).ACME_API_KEY, undefined, "the given env is not changed");
  });

  it("leaves the env alone when it names any credential, so the two never mix", async () => {
    const store = memoryStore();
    store.entries.set("default", JSON.stringify({ API_USERNAME: "ada", API_PASSWORD: "from-keychain" }));
    const env = { prefix: "OCTRI", vars: { OCTRI_API_USERNAME: "bob" } };
    const result = await withKeychainCredential(env, "default", store);
    assert.equal(result.source, "env");
    assert.equal(result.env.vars.OCTRI_API_PASSWORD, undefined);
  });

  it("says none without a store, an entry, or a credential in the entry", async () => {
    const env = { prefix: "OCTRI", vars: {} };
    assert.equal((await withKeychainCredential(env, "x", null)).source, "none");
    assert.equal((await withKeychainCredential(env, "x", memoryStore())).source, "none");
    const store = memoryStore();
    store.entries.set("x", JSON.stringify({ API_KEY_HEADER: "X-Only-A-Header" }));
    assert.equal((await withKeychainCredential(env, "x", store)).source, "none");
  });
});

describe("login and logout", () => {
  it("asks for an API key hidden and its header shown, and saves both", async () => {
    const store = memoryStore();
    const io = answering("sk_live_123", "X-Acme-Key");
    assert.equal(await runLogin({ auth: "apiKey", account: "default", envPrefix: "ACME", store, io }), 0);
    assert.deepEqual(io.asked.map((a) => a.hidden), [true, false]);
    assert.deepEqual(JSON.parse(store.entries.get("default") ?? "{}"), { API_KEY: "sk_live_123", API_KEY_HEADER: "X-Acme-Key" });
    assert.ok(!io.out.includes("sk_live_123"), "the key is never printed");
  });

  it("asks for a token, or a username and password, by scheme", async () => {
    const store = memoryStore();
    await runLogin({ auth: "oauth2", account: "a", envPrefix: "OCTRI", store, io: answering("tok_abc") });
    assert.deepEqual(JSON.parse(store.entries.get("a") ?? "{}"), { API_TOKEN: "tok_abc" });
    await runLogin({ auth: "basic", account: "b", envPrefix: "OCTRI", store, io: answering("ada", "s3cret pass") });
    assert.deepEqual(JSON.parse(store.entries.get("b") ?? "{}"), { API_USERNAME: "ada", API_PASSWORD: "s3cret pass" });
  });

  it("saves nothing for an empty answer, and explains a missing keychain", async () => {
    const store = memoryStore();
    assert.equal(await runLogin({ auth: "bearer", account: "a", envPrefix: "OCTRI", store, io: answering("") }), 1);
    assert.equal(store.entries.size, 0);
    const io = answering();
    assert.equal(await runLogin({ auth: "bearer", account: "a", envPrefix: "ACME", store: null, io }), 1);
    assert.match(io.out, /ACME_API_TOKEN/);
  });

  it("logs out by removing the entry", async () => {
    const store = memoryStore();
    store.entries.set("a", "{}");
    const io = answering();
    assert.equal(await runLogout({ account: "a", store, envPrefix: "OCTRI", io }), 0);
    assert.equal(store.entries.has("a"), false);
    assert.match(io.out, /Removed/);
  });
});

describe("a server started on a keychain credential", () => {
  const seen: (string | undefined)[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers["x-acme-key"] as string | undefined);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ echoed: req.headers["x-acme-key"] }));
  });
  let manifest: ToolManifest;

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    manifest = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: "apiKey",
      tools: [
        {
          slug: "listPets",
          name: "listPets",
          description: "listPets",
          deprecated: false,
          inputSchema: { type: "object", properties: {}, required: [] },
          http: { method: "GET", path: "/pets", pathParams: [], queryParams: [], bodyParams: [], constants: [] },
          policy: "auto",
        },
      ],
    };
  });

  after(() => {
    upstream.close();
  });

  it("calls the API with the stored key, and the config held none", async () => {
    const store = memoryStore();
    await runLogin({ auth: "apiKey", account: "default", envPrefix: "ACME", store, io: answering("sk_keychain_998877", "X-Acme-Key") });
    const { env } = await withKeychainCredential({ prefix: "ACME", vars: {} }, "default", store);
    const server = createServer({ source: { kind: "static", manifest }, env });
    const client = new Client({ name: "keychain-test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(seen.at(-1), "sk_keychain_998877");
    // Echoed back by the API, taken out before the agent sees it.
    assert.ok(!JSON.stringify(result.content).includes("sk_keychain_998877"));
    await client.close();
  });
});
