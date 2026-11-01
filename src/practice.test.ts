import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  createServer,
  PRACTICE_BASE_URL,
  PRACTICE_CONTROL,
  PRACTICE_HEADER,
  PRACTICE_LIMITS,
  PRACTICE_META_KEY,
  PRACTICE_OFF_TEXT,
  PRACTICE_TOOL_PREFIX,
  practiceFetch,
  PracticeSession,
  UsageReporter,
} from "./core.js";

import type { CallEvent, ChainTool, CreateServerOptions, OperationTool, PracticeData, ToolManifest } from "./core.js";

// Practice mode end to end over the SDK's in-memory transport, with the global
// fetch replaced by one that fails the test: practice must never reach a network.

function op(name: string, method: string, path: string, extra: Partial<OperationTool> = {}): OperationTool {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1] ?? "", wireName: m[1] ?? "" }));
  const body = method === "POST" || method === "PATCH" || method === "PUT";
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(pathParams.map((p) => [p.name, { type: "string" }])),
        ...(body ? { body: { type: "object", properties: {} } } : {}),
        ...(method === "GET" && pathParams.length === 0 ? { limit: { type: "integer" } } : {}),
      },
      required: pathParams.map((p) => p.name),
    },
    http: {
      method,
      path,
      pathParams,
      queryParams: method === "GET" && pathParams.length === 0 ? [{ name: "limit", wireName: "limit" }] : [],
      bodyParams: [],
      constants: [],
    },
    policy: method === "GET" ? "auto" : "confirm",
    ...extra,
  };
}

const listPets = op("listPets", "GET", "/pets");
const createPet = op("createPet", "POST", "/pets");
const getPet = op("getPet", "GET", "/pets/{petId}");
const updatePet = op("updatePet", "PATCH", "/pets/{petId}");
const deletePet = op("deletePet", "DELETE", "/pets/{petId}");

const petSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "string", pattern: "^pet_[a-z0-9]{10}$" },
    name: { type: "string" },
    tag: { type: "string", enum: ["dog", "cat"] },
    created_at: { type: "string", format: "date-time" },
  },
};

const practice: PracticeData = {
  "slug-listPets": {
    status: 200,
    example: { data: [{ id: "pet_seed000001", name: "Rex", tag: "dog" }], has_more: false },
  },
  "slug-createPet": { status: 201, schema: petSchema, errors: [{ status: 409, example: { error: "duplicate pet" } }] },
  "slug-getPet": { status: 200, schema: petSchema, errors: [{ status: 404, example: { error: "pet not found" } }] },
  "slug-updatePet": { status: 200, schema: petSchema },
  "slug-deletePet": { status: 204 },
};

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

const manifest = (extra: Partial<ToolManifest> = {}): ToolManifest => ({
  tools: [listPets, createPet, getPet, updatePet, deletePet],
  chains: [adopt],
  baseUrl: "https://api.real.example",
  auth: "bearer",
  practice,
  ...extra,
});

const text = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;

/** The JSON body under a practice result's request line. */
function body(result: unknown): Record<string, unknown> {
  const t = text(result);
  const start = t.indexOf("{", t.indexOf("→"));
  return JSON.parse(t.slice(start, t.lastIndexOf("}") + 1)) as Record<string, unknown>;
}

async function connect(options: Partial<CreateServerOptions> & { manifest?: ToolManifest } = {}) {
  const { manifest: m, ...rest } = options;
  const server = createServer({
    source: { kind: "static", manifest: m ?? manifest() },
    env: { prefix: "OCTRI", vars: { OCTRI_API_TOKEN: "real-secret-token" } },
    practice: true,
    ...rest,
  });
  const client = new Client({ name: "practice-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    return { action: "accept", content: {} };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server, prompts: () => prompts };
}

describe("practice session", () => {
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = (() => {
      throw new Error("practice mode reached the network");
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("a create shows up in a later list and get, an update sticks, a delete gives 404", async () => {
    const { client } = await connect();
    const created = await client.callTool({ name: "createPet", arguments: { body: { name: "Biscuit", tag: "cat" } } });
    assert.notEqual(created.isError, true, text(created));
    const pet = body(created);
    assert.equal(pet["name"], "Biscuit");
    assert.equal(pet["tag"], "cat");
    assert.match(pet["id"] as string, /^pet_[a-z0-9]{10}$/);
    assert.ok(text(created).includes("201 Created"));

    const list = body(await client.callTool({ name: "listPets", arguments: {} }));
    const ids = (list["data"] as { id: string }[]).map((p) => p.id);
    assert.equal(ids[0], pet["id"], "newest first");
    assert.ok(ids.includes("pet_seed000001"), "the documented example stays");

    const got = body(await client.callTool({ name: "getPet", arguments: { petId: pet["id"] } }));
    assert.deepEqual(got, pet);

    const updated = body(await client.callTool({ name: "updatePet", arguments: { petId: pet["id"], body: { name: "Biscuit II" } } }));
    assert.equal(updated["name"], "Biscuit II");
    assert.equal(updated["tag"], "cat");
    assert.equal(body(await client.callTool({ name: "getPet", arguments: { petId: pet["id"] } }))["name"], "Biscuit II");

    const deleted = await client.callTool({ name: "deletePet", arguments: { petId: pet["id"] } });
    assert.notEqual(deleted.isError, true);
    assert.ok(text(deleted).includes("204"));
    const gone = await client.callTool({ name: "getPet", arguments: { petId: pet["id"] } });
    assert.equal(gone.isError, true);
    assert.ok(text(gone).includes("404"));
    assert.ok(text(gone).includes("pet not found"), "the documented 404 example");
    const after = body(await client.callTool({ name: "listPets", arguments: {} }));
    assert.ok(!(after["data"] as { id: string }[]).some((p) => p.id === pet["id"]));
  });

  it("the same call gives the same answer; an unknown id is echoed into a generated record", async () => {
    const one = await connect();
    const two = await connect();
    const a = body(await one.client.callTool({ name: "getPet", arguments: { petId: "pet_abcdefghij" } }));
    const b = body(await two.client.callTool({ name: "getPet", arguments: { petId: "pet_abcdefghij" } }));
    assert.deepEqual(a, b);
    assert.equal(a["id"], "pet_abcdefghij");
    const c = body(await one.client.callTool({ name: "getPet", arguments: { petId: "pet_zzzzzzzzzz" } }));
    assert.notDeepEqual({ ...a, id: "" }, { ...c, id: "" });
  });

  it("two sessions never see each other's records", async () => {
    const one = await connect();
    const two = await connect();
    const pet = body(await one.client.callTool({ name: "createPet", arguments: { body: { name: "Mine" } } }));
    const list = body(await two.client.callTool({ name: "listPets", arguments: {} }));
    assert.ok(!(list["data"] as { id: string }[]).some((p) => p.id === pet["id"]));
  });

  it("limit sizes a list, capped", async () => {
    const { client } = await connect();
    const three = body(await client.callTool({ name: "listPets", arguments: { limit: 3 } }));
    assert.equal((three["data"] as unknown[]).length, 3);
    const many = body(await client.callTool({ name: "listPets", arguments: { limit: 500 } }));
    assert.equal((many["data"] as unknown[]).length, PRACTICE_LIMITS.listItems);
  });

  it("records are bounded per collection and per session", () => {
    const session = new PracticeSession();
    const fetcher = practiceFetch(manifest(), session);
    const posts = Array.from({ length: PRACTICE_LIMITS.records + 20 }, (_, i) =>
      fetcher(`${PRACTICE_BASE_URL}/pets`, { method: "POST", body: JSON.stringify({ name: `p${i}` }) }),
    );
    return Promise.all(posts).then(async () => {
      assert.equal(session.size, PRACTICE_LIMITS.perCollection);
      const list = (await (await fetcher(`${PRACTICE_BASE_URL}/pets`)).json()) as { data: { name: string }[] };
      assert.equal(list.data[0]?.name, `p${PRACTICE_LIMITS.records + 19}`);
    });
  });

  it("simulate_error fails the next call with the documented error, and the error guide speaks", async () => {
    const { client } = await connect();
    const armed = await client.callTool({ name: PRACTICE_CONTROL, arguments: { action: "simulate_error", tool: "createPet", status: 409 } });
    assert.notEqual(armed.isError, true, text(armed));
    const failed = await client.callTool({ name: "createPet", arguments: { body: { name: "Twin" } } });
    assert.equal(failed.isError, true);
    assert.ok(text(failed).includes("409"));
    assert.ok(text(failed).includes("duplicate pet"));
    assert.ok(failed.structuredContent !== undefined, "the error guide's facts");
    assert.equal((failed._meta as Record<string, unknown>)[PRACTICE_META_KEY], true);
    const next = await client.callTool({ name: "createPet", arguments: { body: { name: "Twin" } } });
    assert.notEqual(next.isError, true, "armed once");

    await client.callTool({ name: PRACTICE_CONTROL, arguments: { action: "simulate_error", tool: "getPet", status: 503, times: 2 } });
    for (let i = 0; i < 2; i++) {
      const down = await client.callTool({ name: "getPet", arguments: { petId: "pet_x" } });
      assert.equal(down.isError, true);
      assert.ok(text(down).includes("503"));
    }
    const bad = await client.callTool({ name: PRACTICE_CONTROL, arguments: { action: "simulate_error", tool: "nope" } });
    assert.equal(bad.isError, true);
  });

  it("reset forgets the session's records", async () => {
    const { client } = await connect();
    const pet = body(await client.callTool({ name: "createPet", arguments: { body: { name: "Temp" } } }));
    await client.callTool({ name: PRACTICE_CONTROL, arguments: { action: "reset" } });
    const list = body(await client.callTool({ name: "listPets", arguments: {} }));
    assert.ok(!(list["data"] as { id: string }[]).some((p) => p.id === pet["id"]));
  });

  it("marks every tool and every result, and lists the control tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools.filter((t) => !t.name.startsWith("search_docs") && t.name !== PRACTICE_CONTROL)) {
      assert.ok(t.description?.startsWith(PRACTICE_TOOL_PREFIX), t.name);
      assert.ok(!t.description?.includes("asks the user to approve"), "no prompt is promised");
    }
    assert.ok(tools.some((t) => t.name === PRACTICE_CONTROL));
    assert.equal(client.getServerVersion()?.name, "@octri/mcp (practice)");
    assert.match(client.getInstructions() ?? "", /practice mode/i);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.ok(text(result).startsWith(PRACTICE_HEADER));
    assert.equal((result._meta as Record<string, unknown>)[PRACTICE_META_KEY], true);
    const unknown = await client.callTool({ name: "noSuchTool", arguments: {} });
    assert.ok(text(unknown).startsWith(PRACTICE_HEADER));
  });

  it("skips approval prompts, says one would be asked, and never sends the real credential", async () => {
    const { client, prompts } = await connect();
    const result = await client.callTool({ name: "createPet", arguments: { body: { name: "Quiet" } } });
    assert.equal(prompts(), 0);
    assert.ok(text(result).includes("In real use, this call asks the user to approve it"));
    assert.ok(!text(result).includes("api.real.example"), "requests go to the reserved host");
    assert.ok(!text(result).includes("real-secret-token"));
  });

  it("chains run step by step through practice, state carried between steps", async () => {
    const { client, prompts } = await connect();
    const result = await client.callTool({ name: "adopt_pet", arguments: { name: "Chained" } });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(prompts(), 0);
    assert.ok(text(result).startsWith(PRACTICE_HEADER));
    assert.ok(text(result).includes("Chained"));
  });

  it("search mode lists marked meta tools, and call_tool runs through practice", async () => {
    const { client } = await connect({ toolMode: "search" });
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_tools");
    assert.ok(search?.description?.startsWith(PRACTICE_TOOL_PREFIX));
    const result = await client.callTool({ name: "call_tool", arguments: { name: "createPet", arguments: { body: { name: "Found" } } } });
    assert.ok(text(result).startsWith(PRACTICE_HEADER));
    assert.equal(body(result)["name"], "Found");
    const control = await client.callTool({ name: "call_tool", arguments: { name: PRACTICE_CONTROL, arguments: { action: "reset" } } });
    assert.equal(control.isError, true, "the control tool is called directly");
  });

  it("user limits still apply: read-only hides writes", async () => {
    const { client } = await connect({ permissions: { allow: new Set(), deny: new Set(), readOnly: true, dryRun: false } });
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === "createPet"));
    const refused = await client.callTool({ name: "createPet", arguments: { body: {} } });
    assert.equal(refused.isError, true);
  });

  it("practice wins over dry run", async () => {
    const { client } = await connect({ permissions: { allow: new Set(), deny: new Set(), readOnly: false, dryRun: true } });
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.ok(!text(result).includes("Dry run"));
    assert.ok(text(result).includes("Rex"));
  });

  it("without practice data, every call says practice mode is off and nothing is sent", async () => {
    const { practice: _practice, ...withoutPractice } = manifest();
    const { client } = await connect({ manifest: withoutPractice });
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes(PRACTICE_OFF_TEXT));
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === PRACTICE_CONTROL));
  });

  it("a session past its call limit must start over", async () => {
    const { client } = await connect({ practice: { callLimit: 2 } });
    await client.callTool({ name: "listPets", arguments: {} });
    await client.callTool({ name: "listPets", arguments: {} });
    const third = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(third.isError, true);
    assert.match(text(third), /limit reached/);
  });

  it("usage counts practice calls apart, chain steps included", async () => {
    const events: CallEvent[] = [];
    const reporter = new UsageReporter("http://unused.invalid", async () => undefined);
    reporter.record = (_projectId, event) => void events.push(event);
    const { client } = await connect({
      reporter,
      source: { kind: "static", manifest: manifest(), octri: { apiUrl: "http://unused.invalid", projectId: "p1", docs: false } },
    });
    await client.callTool({ name: "listPets", arguments: {} });
    await client.callTool({ name: "adopt_pet", arguments: { name: "Counted" } });
    await client.callTool({ name: PRACTICE_CONTROL, arguments: { action: "simulate_error", tool: "listPets" } });
    await client.callTool({ name: "listPets", arguments: {} });
    assert.ok(events.length >= 4);
    assert.ok(events.every((e) => e.outcome === "practice"), JSON.stringify(events.map((e) => e.outcome)));
  });

  it("change notices and what_changed are off in practice", async () => {
    const changes = {
      release: 2,
      history: [
        { release: 1, at: new Date().toISOString(), tools: [] },
        { release: 2, at: new Date().toISOString(), tools: [{ name: "listPets", status: "changed" as const, breaking: false, summary: "x" }] },
      ],
    };
    const withChanges = manifest({ changes: changes as unknown as NonNullable<ToolManifest["changes"]> });
    // The same manifest outside practice does list it, so the check below means something.
    const real = await connect({ manifest: withChanges, practice: false });
    assert.ok((await real.client.listTools()).tools.some((t) => t.name === "what_changed"));
    const { client } = await connect({ manifest: withChanges });
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === "what_changed"));
  });

  it("the env flag turns practice on when the host does not say", async () => {
    const server = createServer({
      source: { kind: "static", manifest: manifest() },
      env: { prefix: "ACME", vars: { ACME_PRACTICE: "1" } },
    });
    const client = new Client({ name: "env", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.ok(text(result).startsWith(PRACTICE_HEADER));
  });
});

describe("practice off", () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    calls = 0;
  });
  before(() => {
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"live":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("a normal server ignores practice data and calls the API", async () => {
    const { client } = await connect({ practice: false });
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(calls, 1);
    assert.ok(!text(result).includes(PRACTICE_HEADER));
    const { tools } = await client.listTools();
    assert.ok(!tools.some((t) => t.name === PRACTICE_CONTROL));
  });
});
