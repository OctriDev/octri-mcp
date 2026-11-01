import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http, { type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  createWorkerServer,
  credentialLabel,
  sessionVars,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type McpSessionObject,
  type OAuthHelpersLike,
  type WorkerEnv,
  type WorkerGrant,
  type WorkerOAuthEnv,
} from "./worker.js";
import { loadSandboxWasm } from "./code-sandbox-node.js";
import type { OperationTool } from "./index.js";

// The Cloudflare Worker host, run under Node's own Request and Response with an
// in-memory stand-in for the Durable Object namespace: one object per id, kept
// for the life of the test, the way Cloudflare keeps a running object. The
// official MCP client talks to it, so sessions, approval prompts and the token
// are exercised the way a real client does.

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
}

function tool(name: string, method: string, policy: "auto" | "confirm"): OperationTool {
  return {
    name,
    slug: name,
    description: name,
    deprecated: false,
    policy,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
  };
}

/** Durable Objects, in memory: ids are 64 hex characters, as Cloudflare's are. */
class MemoryNamespace implements DurableObjectNamespaceLike {
  readonly objects = new Map<string, McpSessionObject>();
  readonly alarms = new Map<string, number>();

  constructor(
    private readonly make: (id: DurableObjectIdLike, namespace: MemoryNamespace) => McpSessionObject,
  ) {}

  newUniqueId(): DurableObjectIdLike {
    const id = randomBytes(32).toString("hex");
    return { toString: () => id };
  }

  idFromString(id: string): DurableObjectIdLike {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("Invalid Durable Object ID");
    return { toString: () => id };
  }

  get(id: DurableObjectIdLike) {
    const key = id.toString();
    let object = this.objects.get(key);
    if (object === undefined) {
      object = this.make(id, this);
      this.objects.set(key, object);
    }
    const target = object;
    return { fetch: (request: Request) => target.fetch(request) };
  }
}

describe("Cloudflare Worker host", () => {
  const hits: string[] = [];
  const reports: string[] = [];
  const upstream = http.createServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers["x-api-key"] ?? ""}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const octriApi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      reports.push(`${req.method ?? ""} ${req.url ?? ""} ${body}`);
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  const tools = [tool("listPets", "GET", "auto"), tool("deletePet", "DELETE", "confirm")];
  const pending: Promise<unknown>[] = [];
  let worker: ReturnType<typeof createWorkerServer>;
  let namespace: MemoryNamespace;
  let env: WorkerEnv;

  before(async () => {
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
    const octriUrl = `http://127.0.0.1:${await listen(octriApi)}`;
    worker = createWorkerServer({
      manifest: {
        tools,
        baseUrl: upstreamUrl,
        auth: "apiKey",
        groups: [{ slug: "reads", name: "Reads", tools: ["listPets"], docs: false }],
        // Read only when a variable asks for practice mode.
        practice: { listPets: { status: 200, example: { data: [{ id: 1, name: "Rex" }] } }, deletePet: { status: 204 } },
      },
      branding: { name: "@acme/pets-mcp", version: "1.2.0" },
      envPrefix: "ACME",
      octri: { apiUrl: octriUrl, projectId: "proj1", docs: false },
    });
    namespace = new MemoryNamespace(
      (id, ns) =>
        new worker.McpSession(
          {
            id,
            storage: {
              setAlarm: async (at) => { ns.alarms.set(id.toString(), at); },
              deleteAlarm: async () => { ns.alarms.delete(id.toString()); },
            },
            waitUntil: (promise) => { pending.push(promise); },
          },
          env,
        ),
    );
    env = { MCP_SESSION: namespace, MCP_AUTH_TOKEN: "s3cret", ACME_API_KEY: "key-123" };
  });

  after(() => {
    upstream.close();
    octriApi.close();
  });

  const call = (request: Request) => worker.fetch(request, env);

  async function connect(options: { approval?: "accept" | "decline"; token?: string } = {}) {
    const client = new Client(
      { name: "worker-test", version: "1" },
      { capabilities: options.approval === undefined ? {} : { elicitation: {} } },
    );
    const prompts: string[] = [];
    if (options.approval !== undefined) {
      const answer = options.approval;
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        return { action: answer, content: {} };
      });
    }
    const transport = new StreamableHTTPClientTransport(new URL("https://acme-pets-mcp.example.workers.dev/mcp"), {
      fetch: (url, init) => call(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${options.token ?? "s3cret"}` } },
    });
    await client.connect(transport as Transport);
    return { client, transport, prompts };
  }

  it("answers a health check without a token", async () => {
    const res = await call(new Request("https://w.test/health"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("refuses to serve before MCP_AUTH_TOKEN is set", async () => {
    const res = await worker.fetch(
      new Request("https://w.test/mcp", { method: "POST", body: "{}" }),
      { MCP_SESSION: namespace, ACME_API_KEY: "key-123" },
    );
    assert.equal(res.status, 503);
    assert.match(await res.text(), /wrangler secret put MCP_AUTH_TOKEN/);
  });

  it("refuses a missing or wrong token", async () => {
    const res = await call(new Request("https://w.test/mcp", { method: "POST", body: "{}" }));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    await assert.rejects(connect({ token: "wrong" }));
  });

  it("refuses a browser origin it was not told to allow", async () => {
    const res = await call(
      new Request("https://w.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret", Origin: "https://evil.test" },
        body: "{}",
      }),
    );
    assert.equal(res.status, 403);
  });

  it("lists the tools with the credential from the Worker's secrets", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name), ["listPets", "deletePet"]);
    assert.equal(client.getServerVersion()?.name, "@acme/pets-mcp");
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(hits.at(-1), "GET /listPets key-123");
    await client.close();
  });

  it("runs an ask-first tool once the user approves, across two requests", async () => {
    const { client, prompts } = await connect({ approval: "accept" });
    const result = await client.callTool({ name: "deletePet", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.match(prompts[0] ?? "", /DELETE http:\/\/127\.0\.0\.1:\d+\/deletePet/);
    assert.equal(hits.at(-1), "DELETE /deletePet key-123");
    await client.close();
  });

  it("holds an ask-first tool the user declines", async () => {
    const before = hits.length;
    const { client } = await connect({ approval: "decline" });
    const result = await client.callTool({ name: "deletePet", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /declined/);
    assert.equal(hits.length, before);
    await client.close();
  });

  it("keeps a session on its own object, and forgets it once ended", async () => {
    const { client, transport } = await connect();
    const id = transport.sessionId ?? "";
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.ok(namespace.objects.has(id));
    assert.ok((namespace.alarms.get(id) ?? 0) > Date.now());
    await transport.terminateSession();
    await client.close();
    assert.equal(namespace.alarms.has(id), false);

    const ended = await call(
      new Request("https://w.test/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer s3cret",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": id,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    assert.equal(ended.status, 404);
  });

  it("answers 404 for a session id that is not one of its objects", async () => {
    const res = await call(
      new Request("https://w.test/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer s3cret", "mcp-session-id": "nope", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    assert.equal(res.status, 404);
    const stream = await call(new Request("https://w.test/mcp", { headers: { Authorization: "Bearer s3cret" } }));
    assert.equal(stream.status, 400);
  });

  it("applies the user's flags and tool group from Worker variables", async () => {
    env = { ...env, ACME_DRY_RUN: "1", ACME_GROUP: "reads" };
    try {
      const before = hits.length;
      const { client } = await connect();
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((t) => t.name), ["listPets"]);
      const result = await client.callTool({ name: "listPets", arguments: {} });
      assert.match(JSON.stringify(result.content), /Dry run/i);
      assert.equal(hits.length, before);
      await client.close();
    } finally {
      const { ACME_DRY_RUN: _dry, ACME_GROUP: _group, ...rest } = env;
      env = rest as WorkerEnv;
    }
  });

  it("answers in practice mode from a Worker variable, with no request and no prompt", async () => {
    env = { ...env, ACME_PRACTICE: "1" };
    try {
      const before = hits.length;
      const { client, prompts } = await connect({ approval: "accept" });
      assert.equal(client.getServerVersion()?.name, "@acme/pets-mcp (practice)");
      const listed = await client.callTool({ name: "listPets", arguments: {} });
      const text = (listed.content as { text: string }[])[0]?.text ?? "";
      assert.match(text, /^PRACTICE MODE/);
      assert.match(text, /Rex/);
      const deleted = await client.callTool({ name: "deletePet", arguments: {} });
      assert.notEqual(deleted.isError, true);
      assert.equal(prompts.length, 0);
      assert.equal(hits.length, before);
      await client.close();
    } finally {
      const { ACME_PRACTICE: _practice, ...rest } = env;
      env = rest as WorkerEnv;
    }
  });

  it("takes the tool mode from a Worker variable", async () => {
    env = { ...env, ACME_TOOL_MODE: "search" };
    try {
      const { client } = await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("search_tools"), names.join(","));
      assert.ok(!names.includes("listPets"), names.join(","));
      await client.close();
    } finally {
      const { ACME_TOOL_MODE: _mode, ...rest } = env;
      env = rest as WorkerEnv;
    }
  });

  it("reports usage to the Octri project when a session closes", async () => {
    const { client, transport } = await connect();
    await client.callTool({ name: "listPets", arguments: {} });
    await transport.terminateSession();
    await client.close();
    await Promise.all(pending);
    const report = reports.find((r) => r.startsWith("POST /public/mcp/proj1/events"));
    assert.ok(report !== undefined, reports.join("\n"));
    assert.match(report, /"tool":"listPets"/);
    assert.match(report, /"outcome":"ok"/);
  });
});

// Code mode on the Worker host: the interpreters run in the object's own
// isolate. This file runs under `--disallow-code-generation-from-strings`, as
// Workers do, so a type-stripper or interpreter glue that compiled code from a
// string would fail here. The wasm is compiled up front, the way a Worker's
// uploaded wasm modules are.
describe("Cloudflare Worker host: code mode", () => {
  const hits: string[] = [];
  const upstream = http.createServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""}`);
    res.setHeader("content-type", "application/json");
    res.end(req.method === "GET" ? JSON.stringify([{ id: "p1" }, { id: "p2" }]) : "{}");
  });
  const pending: Promise<unknown>[] = [];
  let worker: ReturnType<typeof createWorkerServer>;
  let env: WorkerEnv;

  before(async () => {
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
    worker = createWorkerServer({
      manifest: {
        tools: [tool("listPets", "GET", "auto"), tool("deletePet", "DELETE", "confirm")],
        baseUrl: upstreamUrl,
        auth: "apiKey",
        toolMode: "code",
        codeMode: {
          languages: ["typescript", "python"],
          methods: {
            listPets: { typescript: "pets.list", python: "pets.list" },
            deletePet: { typescript: "pets.delete", python: "pets.delete" },
          },
        },
      },
      branding: { name: "@acme/pets-mcp", version: "1.2.0" },
      envPrefix: "ACME",
      codeSandbox: await loadSandboxWasm(),
    });
    const namespace: MemoryNamespace = new MemoryNamespace(
      (id, ns) =>
        new worker.McpSession(
          {
            id,
            storage: {
              setAlarm: async (at) => { ns.alarms.set(id.toString(), at); },
              deleteAlarm: async () => { ns.alarms.delete(id.toString()); },
            },
            waitUntil: (promise) => { pending.push(promise); },
          },
          env,
        ),
    );
    env = { MCP_SESSION: namespace, MCP_AUTH_TOKEN: "s3cret", ACME_API_KEY: "key-123" };
  });

  after(() => {
    upstream.close();
  });

  for (const [language, code] of [
    ["typescript", `const pets: { id: string }[] = await client.pets.list({}); for (const p of pets) await client.pets.delete({}); return pets.length;`],
    ["python", `pets = client.pets.list()\nfor p in pets:\n    client.pets.delete()\nreturn len(pets)`],
  ] as const) {
    it(`${language}: runs a script in the isolate, one approval per write`, async () => {
      hits.length = 0;
      const client = new Client({ name: "worker-code", version: "1" }, { capabilities: { elicitation: {} } });
      let prompts = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        prompts++;
        return { action: "accept", content: {} };
      });
      const transport = new StreamableHTTPClientTransport(new URL("https://acme-pets-mcp.example.workers.dev/mcp"), {
        fetch: (url, init) => worker.fetch(new Request(url, init), env),
        requestInit: { headers: { Authorization: "Bearer s3cret" } },
      });
      await client.connect(transport as Transport);
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["describe_sdk", "run_code"]);
      const result = await client.callTool({ name: "run_code", arguments: { language, code } });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      assert.notEqual(result.isError, true, text);
      assert.match(text, /Result:\n2/);
      assert.equal(prompts, 2);
      assert.deepEqual(hits, ["GET /listPets", "DELETE /deletePet", "DELETE /deletePet"]);
      await client.close();
    });
  }
});

describe("Cloudflare Worker host, OAuth mode", () => {
  const hits: string[] = [];
  const upstream = http.createServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""} ${req.headers["x-api-key"] ?? ""}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const tools = [tool("listPets", "GET", "auto"), tool("deletePet", "DELETE", "confirm")];
  let worker: ReturnType<typeof createWorkerServer>;
  let namespace: MemoryNamespace;
  let env: WorkerEnv;

  before(async () => {
    const upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
    worker = createWorkerServer({
      manifest: { tools, baseUrl: upstreamUrl, auth: "apiKey" },
      branding: { name: "@acme/pets-mcp", version: "1.2.0" },
      envPrefix: "ACME",
      credentialVars: ["ACME_API_KEY"],
    });
    namespace = new MemoryNamespace(
      (id) =>
        new worker.McpSession(
          { id, storage: { setAlarm: async () => {}, deleteAlarm: async () => {} }, waitUntil: () => {} },
          env,
        ),
    );
    // The shared secret is set on purpose: no OAuth session may ever use it.
    env = { MCP_SESSION: namespace, ACME_API_KEY: "shared-secret", ACME_TELEMETRY: "0" };
  });

  after(() => {
    upstream.close();
  });

  const grant = (owner: string, key: string): WorkerGrant => ({ owner, credentials: { ACME_API_KEY: key } });

  /** A client whose requests reach the API handler as the provider passes them: with the grant's props. */
  async function connect(props: unknown, options: { approval?: "accept"; headers?: Record<string, string> } = {}) {
    const client = new Client(
      { name: "worker-oauth-test", version: "1" },
      { capabilities: options.approval === undefined ? {} : { elicitation: {} } },
    );
    const prompts: string[] = [];
    if (options.approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        return { action: "accept", content: {} };
      });
    }
    const transport = new StreamableHTTPClientTransport(new URL("https://acme-pets-mcp.example.workers.dev/mcp"), {
      fetch: (url, init) => worker.oauth.api.fetch(new Request(url, init), env, { props }),
      ...(options.headers !== undefined ? { requestInit: { headers: options.headers } } : {}),
    });
    await client.connect(transport as Transport);
    return { client, transport, prompts };
  }

  it("calls the API with the signed-in user's own key, never the Worker's", async () => {
    const { client } = await connect(grant("owner-a", "key-of-a"));
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(hits.at(-1), "GET /listPets key-of-a");
    await client.close();

    const other = await connect(grant("owner-b", "key-of-b"));
    await other.client.callTool({ name: "listPets", arguments: {} });
    assert.equal(hits.at(-1), "GET /listPets key-of-b");
    await other.client.close();
  });

  it("runs an ask-first tool with the user's key once they approve", async () => {
    const { client, prompts } = await connect(grant("owner-a", "key-of-a"), { approval: "accept" });
    const result = await client.callTool({ name: "deletePet", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(prompts.length, 1);
    assert.equal(hits.at(-1), "DELETE /deletePet key-of-a");
    await client.close();
  });

  it("serves a session only to the grant that opened it", async () => {
    const { client, transport } = await connect(grant("owner-a", "key-of-a"));
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": transport.sessionId ?? "",
      "mcp-protocol-version": "2025-06-18",
    };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    const request = (extra: Record<string, string> = {}) =>
      new Request("https://w.test/mcp", { method: "POST", headers: { ...headers, ...extra }, body });

    const stolen = await worker.oauth.api.fetch(request(), env, { props: grant("owner-b", "key-of-b") });
    assert.equal(stolen.status, 404);
    // The bearer entry carries no grant at all: refused the same way.
    const bearer = await worker.fetch(request({ authorization: "Bearer t" }), { ...env, MCP_AUTH_TOKEN: "t" });
    assert.equal(bearer.status, 404);
    const own = await worker.oauth.api.fetch(request(), env, { props: grant("owner-a", "key-of-a") });
    assert.equal(own.status, 200);
    await client.close();
  });

  it("drops a grant header the client sends, on either entry", async () => {
    const spoofed = { "x-octri-mcp-grant": JSON.stringify(grant("owner-x", "stolen-key")) };
    const viaOauth = await connect(grant("owner-a", "key-of-a"), { headers: spoofed });
    await viaOauth.client.callTool({ name: "listPets", arguments: {} });
    assert.equal(hits.at(-1), "GET /listPets key-of-a");
    await viaOauth.client.close();

    const bearerEnv: WorkerEnv = { ...env, MCP_AUTH_TOKEN: "t" };
    const client = new Client({ name: "worker-oauth-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://w.test/mcp"), {
      fetch: (url, init) => worker.fetch(new Request(url, init), bearerEnv),
      requestInit: { headers: { authorization: "Bearer t", ...spoofed } },
    });
    await client.connect(transport as Transport);
    await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(hits.at(-1), "GET /listPets shared-secret");
    await client.close();
  });

  it("refuses a token whose props carry no credentials, and an unlisted origin", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const empty = await worker.oauth.api.fetch(new Request("https://w.test/mcp", { method: "POST", body }), env, {});
    assert.equal(empty.status, 401);
    const browser = await worker.oauth.api.fetch(
      new Request("https://w.test/mcp", { method: "POST", body, headers: { Origin: "https://evil.test" } }),
      env,
      { props: grant("owner-a", "key-of-a") },
    );
    assert.equal(browser.status, 403);
  });

  it("never falls back to a shared credential the user left out", () => {
    const vars = sessionVars({ ACME_API_KEY: "shared", ACME_READ_ONLY: "1" }, { owner: "o", credentials: {} }, [
      "ACME_API_KEY",
    ]);
    assert.equal(vars["ACME_API_KEY"], undefined);
    assert.equal(vars["ACME_READ_ONLY"], "1");
    assert.equal(sessionVars({ ACME_API_KEY: "shared" }, undefined, ["ACME_API_KEY"])["ACME_API_KEY"], "shared");
  });

  // ─── Consent page ──────────────────────────────────────────────────────────

  class AuthorizationError extends Error {
    override name = "AuthorizationError";
    constructor(
      readonly description: string,
      readonly redirectTo?: string,
    ) {
      super(description);
    }
  }

  /** The provider's helpers, recording what the page asked of them. */
  function fakeProvider(options: { parseError?: Error; clientName?: string; loopback?: boolean } = {}) {
    const calls: string[] = [];
    const completed: { userId: string; props: WorkerGrant; scope: string[] }[] = [];
    const authRequest = { scope: ["mcp"] };
    const helpers: OAuthHelpersLike = {
      async parseAuthRequest() {
        calls.push("parse");
        if (options.parseError !== undefined) throw options.parseError;
        return authRequest;
      },
      async describeConsent() {
        return {
          clientName: options.clientName ?? "Claude",
          redirectHost: options.loopback === true ? "localhost" : "claude.ai",
          redirectIsLoopback: options.loopback === true,
        };
      },
      async beginConsent() {
        calls.push("begin");
        return { handle: "h-1", headers: new Headers({ "Set-Cookie": "__Host-oauth-consent-1=b", "X-Frame-Options": "DENY" }) };
      },
      async approveConsent(_request, handle) {
        calls.push(`approve ${handle}`);
        return { request: authRequest, headers: new Headers({ "Set-Cookie": "cleared" }) };
      },
      async denyConsent(_request, handle) {
        calls.push(`deny ${handle}`);
        return { headers: new Headers({ Location: "https://claude.ai/cb?error=access_denied" }) };
      },
      async completeAuthorization(input) {
        completed.push({ userId: input.userId, props: input.props, scope: input.scope });
        return { redirectTo: "https://claude.ai/cb?code=c1" };
      },
    };
    return { helpers, calls, completed };
  }

  const authorizeUrl = "https://w.test/authorize?response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb";
  const post = (fields: Record<string, string>) =>
    new Request(authorizeUrl, { method: "POST", body: new URLSearchParams(fields) });
  const oauthEnv = (helpers: OAuthHelpersLike): WorkerOAuthEnv => ({ ...env, OAUTH_PROVIDER: helpers });

  it("shows the consent page with a field per credential, escaping what the client chose", async () => {
    const { helpers } = fakeProvider({ clientName: `<script>alert(1)</script>`, loopback: true });
    const res = await worker.oauth.fetch(new Request(authorizeUrl), oauthEnv(helpers));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    const page = await res.text();
    assert.ok(!page.includes("<script>"));
    assert.match(page, /&#60;script&#62;/);
    assert.match(page, /name="ACME_API_KEY" type="password"/);
    assert.match(page, /<label for="f0">API key<\/label>/);
    assert.match(page, /name="handle" value="h-1"/);
    assert.match(page, /Access will be sent to <strong>localhost<\/strong>/);
    assert.match(page, /an app on your computer/);
    assert.ok(!page.includes("\u2014"));
  });

  it("stores the key the user enters in the grant's props, under a fresh owner", async () => {
    const { helpers, calls, completed } = fakeProvider();
    const res = await worker.oauth.fetch(
      post({ handle: "h-1", decision: "approve", ACME_API_KEY: "  key-of-c " }),
      oauthEnv(helpers),
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://claude.ai/cb?code=c1");
    assert.equal(res.headers.get("set-cookie"), "cleared");
    assert.deepEqual(calls, ["parse", "approve h-1"]);
    const [done] = completed;
    assert.ok(done !== undefined);
    assert.deepEqual(done.props.credentials, { ACME_API_KEY: "key-of-c" });
    assert.equal(done.props.owner, done.userId);
    assert.match(done.userId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(done.scope, ["mcp"]);
  });

  it("asks again for an empty key without spending the form's handle", async () => {
    const { helpers, calls, completed } = fakeProvider();
    const res = await worker.oauth.fetch(post({ handle: "h-1", decision: "approve", ACME_API_KEY: " " }), oauthEnv(helpers));
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /Enter your API key\./);
    assert.match(page, /name="handle" value="h-1"/);
    assert.deepEqual(calls, ["parse"]);
    assert.equal(completed.length, 0);
  });

  it("sends a declined request back to the client", async () => {
    const { helpers, calls, completed } = fakeProvider();
    const res = await worker.oauth.fetch(post({ handle: "h-1", decision: "deny" }), oauthEnv(helpers));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://claude.ai/cb?error=access_denied");
    assert.deepEqual(calls, ["parse", "deny h-1"]);
    assert.equal(completed.length, 0);
  });

  it("redirects a bad request only when the provider says the redirect is safe", async () => {
    const safe = fakeProvider({ parseError: new AuthorizationError("bad scope", "https://claude.ai/cb?error=invalid_scope") });
    const redirected = await worker.oauth.fetch(new Request(authorizeUrl), oauthEnv(safe.helpers));
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), "https://claude.ai/cb?error=invalid_scope");

    const unsafe = fakeProvider({ parseError: new AuthorizationError("Invalid redirect URI") });
    const shown = await worker.oauth.fetch(new Request(authorizeUrl), oauthEnv(unsafe.helpers));
    assert.equal(shown.status, 400);
    assert.equal(await shown.text(), "Invalid redirect URI");
  });

  it("answers the health check and nothing else outside /mcp and /authorize", async () => {
    const { helpers } = fakeProvider();
    assert.equal((await worker.oauth.fetch(new Request("https://w.test/health"), oauthEnv(helpers))).status, 200);
    assert.equal((await worker.oauth.fetch(new Request("https://w.test/other"), oauthEnv(helpers))).status, 404);
  });

  it("has no consent page for an API that takes no credentials", async () => {
    const keyless = createWorkerServer({
      manifest: { tools, baseUrl: "https://api.test", auth: "none" },
      branding: { name: "@acme/pets-mcp", version: "1.2.0" },
      envPrefix: "ACME",
    });
    const { helpers, calls } = fakeProvider();
    const res = await keyless.oauth.fetch(new Request(authorizeUrl), oauthEnv(helpers));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });

  it("labels each credential the way the consent page shows it", () => {
    assert.equal(credentialLabel("ACME_API_TOKEN", "ACME"), "API token");
    assert.equal(credentialLabel("ACME_API_USERNAME", "ACME"), "Username");
    assert.equal(credentialLabel("ACME_API_PASSWORD", "ACME"), "Password");
  });
});
