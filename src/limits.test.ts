import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  auditArguments,
  createServer,
  limitResult,
  MemoryCallLimiter,
  noUserLimits,
  nodeCodeSandbox,
  RUN_CODE,
  SessionLimits,
  type AuditEvent,
  type CallEvent,
  type CallLimiter,
  type ChainTool,
  type CodeModeManifest,
  type CodeSandbox,
  type CreateServerOptions,
  type OperationTool,
  type ToolManifest,
  type UsageReporter,
} from "./core.js";

// Spending and safety limits end to end over the SDK's in-memory transport,
// against a fake upstream that counts what actually reached it.

function op(name: string, method: string, path: string, extra: Partial<OperationTool> = {}): OperationTool {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1] ?? "", wireName: m[1] ?? "" }));
  const hasBody = method === "POST" || method === "PATCH";
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(pathParams.map((p) => [p.name, { type: "string" }])),
        ...(hasBody ? { body: { type: "object", properties: { name: { type: "string" }, password: { type: "string" } } } } : {}),
      },
      required: pathParams.map((p) => p.name),
    },
    http: {
      method,
      path,
      pathParams,
      queryParams: [],
      bodyParams: [],
      ...(hasBody ? { requestBody: { contentType: "application/json" } } : {}),
      constants: [],
    },
    policy: method === "GET" ? "auto" : "confirm",
    ...extra,
  } as OperationTool;
}

const listPets = op("listPets", "GET", "/pets");
const createPet = op("createPet", "POST", "/pets");
const getPet = op("getPet", "GET", "/pets/{petId}");
const searchPets = op("searchPets", "POST", "/pets/search", { policy: "auto" });
const tagPet = op("tagPet", "POST", "/pets/{petId}/tags", { policy: "auto" });

const adopt: ChainTool = {
  slug: "adopt",
  name: "adopt_pet",
  description: "Create a pet, then read it back.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  steps: [
    { id: "create", tool: createPet, inputs: { body: { name: "{{args.name}}" } } },
    { id: "read", tool: getPet, inputs: { petId: "{{steps.create.body.id}}" } },
  ],
  policy: "confirm",
  readOnly: false,
  destructive: false,
};

const codeMode: CodeModeManifest = {
  languages: ["typescript", "python"],
  methods: {
    listPets: { typescript: "pets.list", python: "pets.list" },
    createPet: { typescript: "pets.create", python: "pets.create" },
    getPet: { typescript: "pets.get", python: "pets.get" },
  },
};

const SECRET = "sk_live_limits_secret_12345";
let pets: { id: string; name: string }[] = [];
const received: string[] = [];
let upstream: HttpServer;
let baseUrl = "";
let sandbox: CodeSandbox;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
  upstream = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      received.push(`${req.method} ${url.pathname}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.pathname === "/pets") return send(200, pets);
      if (req.method === "POST" && url.pathname === "/pets") {
        const pet = { id: `pet_${pets.length + 1}`, ...(JSON.parse(await readBody(req)) as { name: string }) };
        pets.push(pet);
        return send(201, pet);
      }
      if (req.method === "POST" && url.pathname === "/pets/search") return send(200, pets);
      const one = /^\/pets\/([^/]+)/.exec(url.pathname);
      if (one !== null) {
        const pet = pets.find((p) => p.id === one[1]);
        return pet !== undefined ? send(200, pet) : send(404, { error: "pet not found" });
      }
      return send(404, { error: "no route" });
    })();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const found = await nodeCodeSandbox();
  assert.ok(found !== undefined);
  sandbox = found;
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  pets = [{ id: "pet_0", name: "Rex" }];
  received.length = 0;
});

const manifest = (extra: Partial<ToolManifest> = {}): ToolManifest => ({
  tools: [listPets, createPet, getPet, searchPets, tagPet],
  chains: [adopt],
  baseUrl,
  auth: "bearer",
  ...extra,
});

const text = (result: unknown) => ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;
const structured = (result: unknown) => (result as { structuredContent?: Record<string, unknown> }).structuredContent;

async function connect(
  options: Partial<CreateServerOptions> & {
    manifest?: ToolManifest;
    answer?: "accept" | "decline";
    /** Runs while the approval prompt is open, before it is answered. */
    onPrompt?: () => Promise<void>;
  } = {},
) {
  const { manifest: m, answer = "accept", onPrompt, ...rest } = options;
  const events: CallEvent[] = [];
  const audits: AuditEvent[] = [];
  const reporter = {
    record: (_projectId: string, event: CallEvent) => events.push(event),
    audit: (_projectId: string, event: AuditEvent) => audits.push(event),
  } as unknown as UsageReporter;
  const server = createServer({
    source: { kind: "static", manifest: m ?? manifest(), octri: { apiUrl: "http://127.0.0.1:9", projectId: "p1", docs: false } },
    env: { prefix: "OCTRI", vars: { OCTRI_API_TOKEN: SECRET } },
    status: false,
    reporter,
    limiter: new MemoryCallLimiter(),
    codeSandbox: sandbox,
    ...rest,
  });
  const client = new Client({ name: "limits-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  const prompts: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(String((request.params as { message?: string }).message ?? ""));
    await onPrompt?.();
    return { action: answer, content: {} };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call, events, audits, prompts };
}

// ─── Counting ──────────────────────────────────────────────────────────────────

describe("SessionLimits and MemoryCallLimiter", () => {
  it("allows exactly the cap of writes in a session, then refuses with the count", async () => {
    const limits = new SessionLimits(new MemoryCallLimiter());
    const caps = { writesPerSession: 2 };
    assert.equal(await limits.take("p", createPet, caps), undefined);
    assert.equal(await limits.check("p", [createPet], caps, "createPet"), undefined);
    assert.equal(await limits.take("p", createPet, caps), undefined);
    const hit = await limits.check("p", [createPet], caps, "createPet");
    assert.deepEqual(hit, { limit: "writes_per_session", tool: "createPet", max: 2, count: 2 });
    assert.deepEqual(await limits.take("p", createPet, caps), hit);
    // Reads are not writes.
    assert.equal(await limits.take("p", listPets, caps), undefined);
    assert.equal(limits.writesUsed, 2);
  });

  it("counts calls per minute per tool, and the window resets on the minute", async () => {
    let now = Date.UTC(2026, 9, 30, 12, 0, 10);
    const limiter = new MemoryCallLimiter(() => now);
    const limits = new SessionLimits(limiter, () => now);
    const caps = { callsPerMinute: 2 };
    assert.equal(await limits.take("p", listPets, caps), undefined);
    assert.equal(await limits.take("p", listPets, caps), undefined);
    const hit = await limits.take("p", listPets, caps);
    assert.equal(hit?.limit, "calls_per_minute");
    assert.equal(hit?.count, 2);
    assert.equal(hit?.resetAtMs, Date.UTC(2026, 9, 30, 12, 1, 0));
    // Another tool has its own window.
    assert.equal(await limits.take("p", getPet, caps), undefined);
    // One millisecond before the reset: still refused. At it: room again.
    now = Date.UTC(2026, 9, 30, 12, 0, 59, 999);
    assert.notEqual(await limits.take("p", listPets, caps), undefined);
    now = Date.UTC(2026, 9, 30, 12, 1, 0);
    assert.equal(await limits.take("p", listPets, caps), undefined);
  });

  it("lets a tool's own cap and write flag win over the server-wide ones", async () => {
    const limits = new SessionLimits(new MemoryCallLimiter());
    const caps = {
      writesPerSession: 1,
      callsPerMinute: 100,
      tools: { "slug-searchPets": { write: false }, "slug-getPet": { perMinute: 1 } },
    };
    assert.equal(await limits.take("p", searchPets, caps), undefined);
    assert.equal(await limits.take("p", searchPets, caps), undefined);
    assert.equal(limits.writesUsed, 0);
    assert.equal(await limits.take("p", getPet, caps), undefined);
    assert.equal((await limits.take("p", getPet, caps))?.max, 1);
  });

  it("never lets racing sessions take more than the cap from one shared window", async () => {
    const limiter = new MemoryCallLimiter();
    const sessions = Array.from({ length: 8 }, () => new SessionLimits(limiter));
    const results = await Promise.all(
      sessions.flatMap((s) => Array.from({ length: 5 }, () => s.take("p", listPets, { callsPerMinute: 7 }))),
    );
    assert.equal(results.filter((r) => r === undefined).length, 7);
    // A different project has a window of its own.
    assert.equal(await sessions[0]!.take("other", listPets, { callsPerMinute: 7 }), undefined);
  });

  it("checks that every write a chain plans fits, and that a tool called twice has room for both", async () => {
    const limits = new SessionLimits(new MemoryCallLimiter());
    await limits.take("p", createPet, { writesPerSession: 3 });
    assert.equal((await limits.check("p", [createPet, createPet, createPet], { writesPerSession: 3 }, "chain"))?.tool, "chain");
    assert.equal(await limits.check("p", [createPet, createPet], { writesPerSession: 3 }, "chain"), undefined);
    assert.equal((await limits.check("p", [getPet, getPet], { callsPerMinute: 1 }, "chain"))?.limit, "calls_per_minute");
  });
});

describe("limitResult", () => {
  it("says the cap, the count, when it resets and what to do, as text and as data", () => {
    const now = Date.UTC(2026, 9, 30, 12, 0, 40);
    const minute = limitResult({ limit: "calls_per_minute", tool: "listPets", max: 60, count: 60, resetAtMs: now + 20_000 }, now);
    assert.match(minute.text, /listPets is limited to 60 calls per minute, and 60 were made this minute/);
    assert.match(minute.text, /Retry after 2026-10-30T12:01:00\.000Z \(about 20 s\)/);
    assert.deepEqual(minute.structured, {
      error: "limit_reached",
      limit: "calls_per_minute",
      tool: "listPets",
      max: 60,
      count: 60,
      resetAt: "2026-10-30T12:01:00.000Z",
      retryAfterSeconds: 20,
      hint: "Wait 20 s, then retry. Other tools are not affected.",
    });
    const session = limitResult({ limit: "writes_per_session", tool: "createPet", max: 1, count: 1 }, now);
    assert.match(session.text, /limit of 1 write per session \(1 used\)/);
    assert.equal(session.structured.resetAt, null);
    assert.equal(session.structured.retryAfterSeconds, null);
  });
});

describe("auditArguments", () => {
  it("takes out secret-named values at any depth and the session's credentials anywhere, then caps the size", () => {
    const out = auditArguments(
      { body: { name: "Rex", password: "hunter2", nested: [{ apiKey: "k", note: `token is ${SECRET}` }] }, authorization: "Bearer x" },
      [SECRET],
    );
    assert.equal(
      out,
      JSON.stringify({ body: { name: "Rex", password: "[redacted]", nested: [{ apiKey: "[redacted]", note: "token is [redacted]" }] }, authorization: "[redacted]" }),
    );
    assert.equal(auditArguments({}, []), undefined);
    const long = auditArguments({ text: "x".repeat(10_000) }, []);
    assert.equal(long?.length, 4_096);
    assert.ok(long?.endsWith("…"));
  });
});

// ─── The server ────────────────────────────────────────────────────────────────

describe("createServer with safety limits", () => {
  it("sends writes up to the session cap, then refuses the next before asking, with structured facts", async () => {
    const { call, prompts, events } = await connect({ manifest: manifest({ limits: { writesPerSession: 2 } }) });
    for (const name of ["A", "B"]) {
      const result = await call("createPet", { body: { name } });
      assert.equal(result.isError, undefined, text(result));
    }
    const refused = await call("createPet", { body: { name: "C" } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Not sent: createPet would go past this server's limit of 2 writes per session \(2 used\)/);
    assert.equal(structured(refused)?.["error"], "limit_reached");
    assert.equal(structured(refused)?.["count"], 2);
    // Asked twice, never for the refused one, and the upstream saw two writes.
    assert.equal(prompts.length, 2);
    assert.deepEqual(received, ["POST /pets", "POST /pets"]);
    // Reads still work.
    assert.equal((await call("listPets")).isError, undefined);
    assert.deepEqual(events.map((e) => e.outcome), ["ok", "ok", "limited", "ok"]);
  });

  it("does not count a declined write, a dry run or a practice call", async () => {
    const declined = await connect({ manifest: manifest({ limits: { writesPerSession: 1 } }), answer: "decline" });
    await declined.call("createPet", { body: { name: "A" } });
    await declined.call("createPet", { body: { name: "B" } });
    assert.equal(declined.prompts.length, 2, "both still asked: a no uses no write");

    const dry = await connect({ manifest: manifest({ limits: { writesPerSession: 1 } }), permissions: { ...noUserLimits(), dryRun: true } });
    for (let i = 0; i < 3; i++) assert.match(text(await dry.call("createPet", { body: { name: "A" } })), /Dry run/);

    const practice = await connect({
      manifest: manifest({ limits: { writesPerSession: 1, callsPerMinute: 1 }, practice: { "slug-createPet": { status: 201, example: { id: "pet_x" } } } }),
      practice: true,
    });
    for (let i = 0; i < 3; i++) assert.equal((await practice.call("createPet", { body: { name: "A" } })).isError, undefined);
    assert.deepEqual(received, []);
  });

  it("caps calls per minute per tool, through call_tool in search mode too", async () => {
    const { call } = await connect({ manifest: manifest({ limits: { callsPerMinute: 2 } }), toolMode: "search" });
    assert.equal((await call("call_tool", { name: "listPets", arguments: {} })).isError, undefined);
    assert.equal((await call("call_tool", { name: "listPets", arguments: {} })).isError, undefined);
    const refused = await call("call_tool", { name: "listPets", arguments: {} });
    assert.equal(structured(refused)?.["limit"], "calls_per_minute");
    assert.equal(typeof structured(refused)?.["retryAfterSeconds"], "number");
    assert.equal(received.filter((r) => r === "GET /pets").length, 2);
  });

  it("shares the per-minute window across sessions and tool groups of one project", async () => {
    const limiter: CallLimiter = new MemoryCallLimiter();
    const grouped = manifest({
      limits: { callsPerMinute: 3 },
      groups: [
        { slug: "reads", name: "Reads", docs: false, tools: ["slug-listPets", "slug-getPet"] },
        { slug: "all", name: "All", docs: false, tools: ["slug-listPets", "slug-createPet"] },
      ],
    });
    const a = await connect({ manifest: grouped, limiter, group: "reads" });
    const b = await connect({ manifest: grouped, limiter, group: "all" });
    const c = await connect({ manifest: grouped, limiter });
    const outcomes = [];
    for (const session of [a, b, c, a]) outcomes.push((await session.call("listPets")).isError === true);
    assert.deepEqual(outcomes, [false, false, false, true]);
  });

  it("refuses a whole chain up front when its writes do not fit, and nothing is sent or asked", async () => {
    const { call, prompts, audits } = await connect({ manifest: manifest({ limits: { writesPerSession: 1, audit: true } }) });
    await call("createPet", { body: { name: "first" } });
    received.length = 0;
    const refused = await call("adopt_pet", { name: "Rex" });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Nothing was sent\./);
    assert.equal(structured(refused)?.["tool"], "adopt_pet");
    assert.equal(prompts.length, 1);
    assert.deepEqual(received, []);
    assert.deepEqual(audits.map((e) => `${e.tool}:${e.outcome}:${e.chain ?? ""}`), ["createPet:ok:", "createPet:limited:adopt"]);
  });

  it("stops a chain that hits a cap partway, and the steps already sent stand", async () => {
    const limiter = new MemoryCallLimiter();
    const limits = { tools: { "slug-getPet": { perMinute: 1 } }, audit: true as const };
    const other = await connect({ manifest: manifest({ limits }), limiter });
    // While this chain's approval prompt is open, another session takes getPet's last call.
    const { call, audits } = await connect({
      manifest: manifest({ limits }),
      limiter,
      onPrompt: async () => {
        await other.call("getPet", { petId: "pet_0" });
      },
    });
    const result = await call("adopt_pet", { name: "Rex" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Step 2 of 2 \(read: GET \/pets\/\{petId\}\) failed\. Not sent: getPet at step read is limited to 1 call per minute/);
    assert.match(text(result), /Already sent, and not undone: step 1 create 201\./);
    assert.equal(structured(result)?.["step"], "read");
    assert.equal(pets.length, 2, "the created pet stays");
    assert.deepEqual(audits.map((e) => `${e.tool}:${e.outcome}`), ["createPet:ok"]);
  });

  it("lets a code mode script run until the cap, then hands it the limit as an error it can read", async () => {
    const { call } = await connect({ manifest: manifest({ toolMode: "code", codeMode, limits: { writesPerSession: 2 } }) });
    const result = await call(RUN_CODE, {
      language: "typescript",
      code: [
        "const made = [];",
        "for (const name of ['a', 'b', 'c', 'd']) {",
        "  try { made.push((await client.pets.create({ body: { name } })).id); }",
        "  catch (e) { return { made, kind: e.kind, name: e.name, limit: e.body.limit, max: e.body.max, count: e.body.count }; }",
        "}",
        "return { made };",
      ].join("\n"),
    });
    assert.equal(result.isError, undefined, text(result));
    assert.match(text(result), /"made": \[\s*"pet_2",\s*"pet_3"\s*\]/);
    assert.match(text(result), /"kind": "limit"/);
    assert.match(text(result), /"name": "CallLimitReached"/);
    assert.match(text(result), /"limit": "writes_per_session"/);
    const calls = structured(result)?.["calls"] as { outcome: string }[];
    assert.deepEqual(calls.map((c) => c.outcome), ["201", "201", "not sent, limit reached"]);
    assert.equal(received.filter((r) => r === "POST /pets").length, 2);
  });

  it("audits every attempted write with how it was approved, and never a read", async () => {
    const { call, audits } = await connect({
      manifest: manifest({ limits: { audit: true } }),
      permissions: { ...noUserLimits(), allow: new Set(["createPet"]) },
    });
    await call("createPet", { body: { name: "Rex", password: "hunter2" } });
    await call("tagPet", { petId: "pet_0", body: { name: `tag ${SECRET}` } });
    await call("listPets");
    assert.equal(audits.length, 2);
    const [created, tagged] = audits;
    assert.equal(created?.approval, "allow_list");
    assert.equal(created?.outcome, "ok");
    assert.equal(created?.status, 201);
    assert.equal(created?.method, "POST");
    assert.equal(created?.path, "/pets");
    assert.equal(created?.arguments, JSON.stringify({ body: { name: "Rex", password: "[redacted]" } }));
    assert.equal(tagged?.approval, "auto");
    assert.ok(!tagged?.arguments?.includes(SECRET));
    assert.match(created?.session ?? "", /^[a-f0-9]{24}$/);
    assert.equal(created?.session, tagged?.session);
    assert.equal(created?.client, "limits-test");
  });

  it("audits a declined write as declined, asked by prompt", async () => {
    const { call, audits } = await connect({ manifest: manifest({ limits: { audit: true } }), answer: "decline" });
    await call("createPet", { body: { name: "Rex" } });
    assert.deepEqual(audits.map((e) => `${e.approval}:${e.outcome}`), ["prompt:declined"]);
  });

  it("keeps no audit entries when the owner keeps no log", async () => {
    const { call, audits } = await connect({ manifest: manifest({ limits: { writesPerSession: 5 } }) });
    await call("createPet", { body: { name: "Rex" } });
    assert.deepEqual(audits, []);
  });
});
