import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  chainStatus,
  clearStatusCache,
  createServer,
  httpStatusSource,
  operationStatus,
  readOutageStatus,
  SEARCH_MODE_THRESHOLD,
  STATUS_META_KEY,
  UsageReporter,
} from "./core.js";

import type {
  ChainTool,
  CreateServerOptions,
  EndpointStatus,
  OperationTool,
  OutageStatus,
  StatusSource,
  ToolManifest,
} from "./core.js";

// Outage-aware tools end to end, over the SDK's in-memory transport against a
// local upstream whose endpoints fail on demand, with the status a fake
// monitor reports. Nothing is claimed the monitor did not see.

function tool(name: string, method: string, path: string, extra: Partial<OperationTool> = {}): OperationTool {
  return {
    slug: `${method.toLowerCase()}-${name}`,
    name,
    description: `${name} description.`,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy: "auto",
    ...extra,
  };
}

const listPets = tool("listPets", "GET", "/pets", { group: "Pets" });
const listOrders = tool("listOrders", "GET", "/orders", { group: "Store" });
const getHealth = tool("getHealth", "GET", "/health", { group: "Store" });

const restock: ChainTool = {
  slug: "restock",
  name: "restock",
  description: "List pets, then orders.",
  inputSchema: { type: "object", properties: {}, required: [] },
  steps: [
    { id: "pets", tool: listPets, inputs: {} },
    { id: "orders", tool: listOrders, inputs: {} },
  ],
  policy: "auto",
  readOnly: true,
  destructive: false,
};

const MIN = 60_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

function entry(state: EndpointStatus["state"], extra: Partial<EndpointStatus> = {}): EndpointStatus {
  return {
    state,
    since: iso(-12 * MIN),
    checkedAt: iso(-1 * MIN),
    nextCheckAt: iso(4 * MIN),
    staleAt: iso(10 * MIN),
    statusCode: state === "down" ? 503 : 200,
    reason: state === "down" ? "status" : "latency",
    ...extra,
  };
}

/** A status source whose answer a test sets. */
function fakeMonitor(): StatusSource & { status: OutageStatus | null; fail: boolean; reads: number } {
  return {
    status: null,
    fail: false,
    reads: 0,
    async read() {
      this.reads += 1;
      if (this.fail) throw new Error("monitor unreachable");
      return this.status;
    },
  };
}

const text = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;

describe("outage-aware tools", () => {
  // Paths in `failing` answer with that status; everything else is 200.
  const failing = new Map<string, number>();
  const upstream = http.createServer((req, res) => {
    const code = failing.get(req.url ?? "") ?? 200;
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(code === 200 ? '{"ok":true}' : '{"error":"upstream"}');
  });
  let manifest: ToolManifest;
  let origin: string;
  const monitor = fakeMonitor();
  const clients: Client[] = [];

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    manifest = {
      baseUrl: `${origin}/v1`,
      auth: "none",
      tools: [listPets, listOrders, getHealth],
      chains: [restock],
      groups: [
        { slug: "pets", name: "Pets", docs: false, tools: [listPets.slug], chains: [], prompts: [], resources: [] },
        { slug: "store", name: "Store", docs: false, tools: [listOrders.slug, getHealth.slug], chains: ["restock"], prompts: [], resources: [] },
      ],
    } as unknown as ToolManifest;
  });

  beforeEach(() => {
    failing.clear();
    monitor.fail = false;
    monitor.status = null;
  });

  after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    upstream.close();
  });

  async function connect(extra: Partial<CreateServerOptions> = {}, data: ToolManifest = manifest) {
    const server = createServer({
      source: { kind: "static", manifest: data },
      env: { prefix: "OCTRI", vars: {} },
      status: monitor,
      ...extra,
    });
    const client = new Client({ name: "outage-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  }

  const down = (...slugs: string[]): OutageStatus => ({
    enabled: true,
    available: true,
    origin,
    operations: Object.fromEntries(slugs.map((s) => [s, entry("down")])),
  });

  it("up: lists plain descriptions and returns raw failures", async () => {
    monitor.status = { enabled: true, available: true, origin, operations: {} };
    const client = await connect();
    const { tools } = await client.listTools();
    const pets = tools.find((t) => t.name === "listPets");
    assert.equal(pets?.description, "listPets description.");
    assert.equal(pets?._meta, undefined);

    // A 5xx with no monitor behind it is a one-off: raw, never "known outage".
    failing.set("/v1/pets", 502);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /Known outage/);
    assert.match(text(result), /502/);
    // Not an outage: the call carries the error guide's data, never "known_outage".
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.["error"], "request_failed");
  });

  it("down: warns before the call and turns the failed call into a structured outage", async () => {
    monitor.status = down(listPets.slug);
    const client = await connect();
    const { tools } = await client.listTools();
    const pets = tools.find((t) => t.name === "listPets");
    assert.match(pets?.description ?? "", /^\[Failing now\] This endpoint has been failing since (\d{4}-\d\d-\d\d )?\d\d:\d\d UTC/);
    assert.match(pets?.description ?? "", /last check got HTTP 503/);
    assert.match(pets?.description ?? "", /listPets description\.$/);
    assert.equal((pets?._meta?.[STATUS_META_KEY] as { state: string }).state, "down");
    assert.equal(tools.find((t) => t.name === "listOrders")?.description, "listOrders description.");

    failing.set("/v1/pets", 503);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /^Known outage: listPets failed while its endpoint has been down since /);
    assert.match(text(result), /Do not retry before /);
    assert.match(text(result), /GET http:\/\/127\.0\.0\.1:\d+\/v1\/pets → 503/);
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal(data["error"], "known_outage");
    assert.equal(data["scope"], "endpoint");
    assert.equal(data["statusCode"], 503);
    assert.equal(data["monitorStatusCode"], 503);
    assert.ok(typeof data["retryAfterSeconds"] === "number" && data["retryAfterSeconds"] >= 60);
  });

  it("down: a call that succeeds goes through untouched, and a 4xx stays the API's answer", async () => {
    monitor.status = down(listPets.slug);
    const client = await connect();
    const ok = await client.callTool({ name: "listPets", arguments: {} });
    assert.notEqual(ok.isError, true);
    assert.match(text(ok), /\{"ok":true\}/);

    failing.set("/v1/pets", 404);
    const notFound = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal((notFound.structuredContent as Record<string, unknown> | undefined)?.["error"], "request_failed");
    assert.doesNotMatch(text(notFound), /Known outage/);
    assert.match(text(notFound), /\[Failing now\]/);
  });

  it("down: no answer at all (connection refused) is the outage too", async () => {
    const dead = { ...manifest, baseUrl: "http://127.0.0.1:9/v1" } as ToolManifest;
    monitor.status = { ...down(listPets.slug), origin: "http://127.0.0.1:9" };
    const client = await connect({}, dead);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.match(text(result), /^Known outage/);
    assert.equal((result.structuredContent as Record<string, unknown>)["statusCode"], null);
  });

  it("degraded: says slow, and never calls a failure an outage", async () => {
    monitor.status = { enabled: true, available: true, origin, operations: { [listPets.slug]: entry("degraded") } };
    const client = await connect();
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "listPets")?.description ?? "", /^\[Slow now\]/);
    failing.set("/v1/pets", 503);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    // Not an outage: the call carries the error guide's data, never "known_outage".
    assert.equal((result.structuredContent as Record<string, unknown> | undefined)?.["error"], "request_failed");
    assert.doesNotMatch(text(result), /Known outage/);
    assert.match(text(result), /\[Slow now\]/);
  });

  it("stale: a check the monitor stopped running says nothing, so a recovered API is not down", async () => {
    monitor.status = {
      enabled: true,
      available: true,
      origin,
      operations: { [listPets.slug]: entry("down", { staleAt: iso(-1 * MIN) }) },
    };
    const client = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === "listPets")?.description, "listPets description.");
    failing.set("/v1/pets", 503);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.doesNotMatch(text(result), /Known outage/);
  });

  it("monitoring unreachable: fails open, the server works as if there were no monitoring", async () => {
    monitor.fail = true;
    const client = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === "listPets")?.description, "listPets description.");
    failing.set("/v1/pets", 503);
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.doesNotMatch(text(result), /Known outage/);
    assert.match(text(result), /503/);

    // The monitor itself said it could not see: the same.
    monitor.fail = false;
    monitor.status = { ...down(listPets.slug), available: false };
    const again = await client.callTool({ name: "listPets", arguments: {} });
    assert.doesNotMatch(text(again), /Known outage/);
  });

  it("another host: a server pointed elsewhere by API_BASE_URL is told nothing", async () => {
    monitor.status = down(listPets.slug);
    const client = await connect({ env: { prefix: "OCTRI", vars: { OCTRI_API_BASE_URL: "http://localhost:1/v1" } } });
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === "listPets")?.description, "listPets description.");
  });

  it("owner turned it off: no status is read at all", async () => {
    monitor.status = down(listPets.slug);
    const before = monitor.reads;
    const client = await connect({}, { ...manifest, outageWarnings: false } as ToolManifest);
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === "listPets")?.description, "listPets description.");
    assert.equal(monitor.reads, before);
  });

  it("API-wide: every monitored endpoint down covers the tools with no check of their own", async () => {
    monitor.status = {
      enabled: true,
      available: true,
      origin,
      api: { ...entry("down"), checks: 2 },
      operations: { [listPets.slug]: entry("down"), [listOrders.slug]: entry("down") },
    };
    const client = await connect();
    const { tools } = await client.listTools();
    const health = tools.find((t) => t.name === "getHealth");
    assert.match(health?.description ?? "", /^\[Failing now\] All 2 endpoints Octri monitors on this API have been failing/);
    assert.equal((health?._meta?.[STATUS_META_KEY] as { scope: string }).scope, "api");
    failing.set("/v1/health", 500);
    const result = await client.callTool({ name: "getHealth", arguments: {} });
    assert.match(text(result), /^Known outage: getHealth failed while the whole API is down: all 2 endpoints/);
    assert.equal((result.structuredContent as Record<string, unknown>)["scope"], "api");
  });

  it("chain: down when one step is, and a failure at that step is the outage", async () => {
    monitor.status = down(listOrders.slug);
    const events: string[] = [];
    const reporter = new UsageReporter("https://api.test/api/v1", async (_url, body) => {
      events.push(body);
    });
    const client = await connect({ reporter, status: monitor, source: { kind: "static", manifest, octri: { apiUrl: "https://api.test/api/v1", projectId: "p1", docs: false } } });
    const { tools } = await client.listTools();
    const chain = tools.find((t) => t.name === "restock");
    assert.match(chain?.description ?? "", /^\[Failing now\] Step listOrders \(GET \/orders\) has been failing/);
    assert.equal((chain?._meta?.[STATUS_META_KEY] as { step: string }).step, "listOrders");

    failing.set("/v1/orders", 503);
    const result = await client.callTool({ name: "restock", arguments: {} });
    assert.match(text(result), /^Known outage: restock failed at step listOrders \(GET \/orders\)/);
    assert.equal((result.structuredContent as Record<string, unknown>)["step"], "listOrders");

    // Usage counts the blocked call apart: the chain and its failing step as
    // outage, the step that went through as ok.
    await reporter.flush();
    const sent = events.flatMap((body) => (JSON.parse(body) as { events: { tool: string; outcome: string }[] }).events);
    assert.deepEqual(
      sent.map((e) => `${e.tool}:${e.outcome}`).sort(),
      ["listOrders:outage", "listPets:ok", "restock:outage"],
    );
  });

  it("usage: a plain failure is an error, a known outage is an outage", async () => {
    monitor.status = down(listPets.slug);
    const events: string[] = [];
    const reporter = new UsageReporter("https://api.test/api/v1", async (_url, body) => {
      events.push(body);
    });
    const client = await connect({ reporter, source: { kind: "static", manifest, octri: { apiUrl: "https://api.test/api/v1", projectId: "p1", docs: false } } });
    failing.set("/v1/pets", 503);
    failing.set("/v1/orders", 503);
    await client.callTool({ name: "listPets", arguments: {} });
    await client.callTool({ name: "listOrders", arguments: {} });
    await reporter.flush();
    const sent = events.flatMap((body) => (JSON.parse(body) as { events: { tool: string; outcome: string }[] }).events);
    assert.deepEqual(sent.map((e) => `${e.tool}:${e.outcome}`), ["listPets:outage", "listOrders:error"]);
  });

  it("list_changed: a call that sees a different picture tells the client to list again", async () => {
    monitor.status = { enabled: true, available: true, origin, operations: {} };
    const client = await connect();
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });
    await client.listTools();
    failing.set("/v1/pets", 503);
    monitor.status = down(listPets.slug);
    await client.callTool({ name: "listPets", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changed, 1);
    // The same picture again: no second notice.
    await client.listTools();
    await client.callTool({ name: "listPets", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(changed, 1);
  });

  it("groups: a group's server warns about its own tools only", async () => {
    monitor.status = down(listPets.slug, listOrders.slug);
    const client = await connect({ group: "store" });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["getHealth", "listOrders", "restock"]);
    assert.match(tools.find((t) => t.name === "listOrders")?.description ?? "", /^\[Failing now\]/);
    assert.equal(tools.find((t) => t.name === "getHealth")?.description, "getHealth description.");
    failing.set("/v1/orders", 503);
    const result = await client.callTool({ name: "listOrders", arguments: {} });
    assert.match(text(result), /^Known outage/);
  });

  it("search mode: search_tools and describe_tool flag it, call_tool returns the outage", async () => {
    const filler = Array.from({ length: SEARCH_MODE_THRESHOLD }, (_, i) =>
      tool(`listItems${i}`, "GET", `/items${i}`, { description: `List store items, page ${i}.` }),
    );
    const big = { ...manifest, tools: [...manifest.tools, ...filler], chains: [] } as ToolManifest;
    monitor.status = down(listPets.slug);
    const client = await connect({}, big);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "search_tools"));

    const found = await client.callTool({ name: "search_tools", arguments: { query: "pets" } });
    assert.match(text(found), /listPets · GET \/pets · .*failing now, per Octri monitoring/);
    const described = await client.callTool({ name: "describe_tool", arguments: { names: ["listPets"] } });
    assert.match(text(described), /\[Failing now\] This endpoint has been failing/);

    failing.set("/v1/pets", 503);
    const called = await client.callTool({ name: "call_tool", arguments: { name: "listPets", arguments: {} } });
    assert.match(text(called), /^Known outage: listPets/);
    assert.equal((called.structuredContent as Record<string, unknown>)["error"], "known_outage");
  });
});

describe("status reading", () => {
  const now = Date.now();

  it("reads only what is well formed, and nothing from a switched-off status", () => {
    assert.deepEqual(readOutageStatus({ enabled: false, operations: { a: entry("down") } }), { enabled: false });
    assert.equal(readOutageStatus("nope"), null);
    const read = readOutageStatus({
      enabled: true,
      origin: "https://api.acme.test",
      operations: { good: entry("down"), bad: { state: "on fire" }, noTime: { state: "down" } },
    });
    assert.deepEqual(Object.keys(read?.operations ?? {}), ["good"]);
  });

  it("matches the origin, ignoring the path the base URL carries", () => {
    const status: OutageStatus = { enabled: true, origin: "https://api.acme.test", operations: { "get-a": entry("down") } };
    assert.equal(operationStatus(status, { slug: "get-a" }, "https://api.acme.test/v2", now)?.scope, "endpoint");
    assert.equal(operationStatus(status, { slug: "get-a" }, "https://staging.acme.test/v2", now), undefined);
    assert.equal(operationStatus(status, { slug: "get-b" }, "https://api.acme.test", now), undefined);
  });

  it("a chain with a degraded step and a down step is down, at the down step", () => {
    const status: OutageStatus = {
      enabled: true,
      origin: "https://api.acme.test",
      operations: { [listPets.slug]: entry("degraded"), [listOrders.slug]: entry("down") },
    };
    const found = chainStatus(status, restock, "https://api.acme.test", now);
    assert.equal(found?.entry.state, "down");
    assert.equal(found?.step?.name, "listOrders");
  });

  it("the HTTP source caches for 30 s, and caches a failure too", async () => {
    clearStatusCache();
    let calls = 0;
    let clock = 1_000_000;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ enabled: true, origin: "https://x.test", operations: {} }));
      throw new Error("down");
    }) as unknown as typeof fetch;
    const source = httpStatusSource("https://api.test/api/v1", "p1", fetchImpl, () => clock);
    assert.equal((await source.read())?.enabled, true);
    assert.equal((await source.read())?.enabled, true);
    assert.equal(calls, 1);
    clock += 31_000;
    assert.equal(await source.read(), null);
    assert.equal(await source.read(), null);
    assert.equal(calls, 2);
  });

  it("the HTTP source fails open on a refused status (a gated project)", async () => {
    clearStatusCache();
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    assert.equal(await httpStatusSource("https://api.test/api/v1", "gated", fetchImpl).read(), null);
  });
});
