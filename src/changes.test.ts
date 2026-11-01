import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CHANGE_NOTE_MAX,
  CHANGE_NOTES_BUDGET,
  changeNote,
  changeNotes,
  foldChanges,
  oldNameAnswer,
  parseSince,
  releasesSince,
  type ToolChanges,
  type ToolRelease,
} from "./changes.js";
import { localChangeState } from "./change-state.js";
import { createServer, loadUserPermissions } from "./core.js";

import type { ChainTool } from "./chains.js";
import type { CreateServerOptions, OperationTool, ToolManifest } from "./core.js";

// "What changed" in the runtime: which releases an agent has not seen, the
// note on each tool they changed, `what_changed`, and a call to a tool that is
// no longer served. Over the SDK's in-memory transport, no upstream needed.

const DAY = 86_400_000;
const NOW = Date.now();
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function tool(name: string, extra: Partial<OperationTool> = {}): OperationTool {
  return {
    slug: `get-${name}`,
    name,
    description: `${name} description.`,
    deprecated: false,
    inputSchema: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] },
    http: { method: "GET", path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy: "auto",
    ...extra,
  };
}

const HISTORY: ToolRelease[] = [
  { release: 1, at: at(40), tools: [] },
  {
    release: 2,
    at: at(20),
    apiVersion: "1.4.0",
    tools: [{ slug: "get-legacy_report", name: "legacy_report", status: "removed", breaking: true }],
  },
  {
    release: 3,
    at: at(2),
    apiVersion: "1.5.0",
    tools: [
      {
        slug: "get-find_orders",
        name: "find_orders",
        previousName: "list_orders",
        status: "renamed",
        breaking: true,
        params: { removed: ["status"], added: [{ name: "limit", required: true, type: "integer" }] },
      },
      { slug: "get-carts", name: "carts", status: "changed", breaking: false, description: true },
      { slug: "get-reports", name: "reports", status: "added", breaking: false },
    ],
  },
];

const CHANGES: ToolChanges = { release: 3, history: HISTORY };

const MANIFEST: ToolManifest = {
  baseUrl: "http://127.0.0.1:9",
  auth: "bearer",
  tools: [tool("find_orders"), tool("carts"), tool("reports"), tool("payments")],
  changes: CHANGES,
};

async function connect(options: Partial<CreateServerOptions> & { manifest?: ToolManifest } = {}) {
  const { manifest, ...rest } = options;
  const source = { kind: "static" as const, manifest: manifest ?? MANIFEST };
  const server = createServer({ source, env: { prefix: "ACME", vars: {} }, status: false, ...rest });
  const client = new Client({ name: "changes-test", version: "1" });
  const listChanged: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged.push(Date.now());
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, source, listChanged };
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("which releases an agent has not seen", () => {
  it("starts after the agent's release, else at the last 14 days", () => {
    assert.deepEqual(releasesSince(CHANGES, 1, NOW).map((r) => r.release), [2, 3]);
    assert.deepEqual(releasesSince(CHANGES, 3, NOW), []);
    assert.deepEqual(releasesSince(CHANGES, null, NOW).map((r) => r.release), [3]);
  });

  it("reads since as a release number or a date", () => {
    assert.equal(parseSince("2", CHANGES), 2);
    assert.equal(parseSince(2, CHANGES), 2);
    assert.equal(parseSince(at(10).slice(0, 10), CHANGES), 2);
    assert.equal(parseSince("last week", CHANGES), undefined);
  });
});

describe("foldChanges", () => {
  it("folds several releases into one entry per tool", () => {
    const folded = foldChanges([
      { release: 4, at: at(3), tools: [{ slug: "a", name: "b", previousName: "a", status: "renamed", breaking: true }] },
      { release: 5, at: at(2), tools: [{ slug: "a", name: "c", previousName: "b", status: "renamed", breaking: true, params: { removed: ["x"] } }] },
    ]);
    assert.equal(folded.length, 1);
    assert.deepEqual(
      { name: folded[0]?.name, previousName: folded[0]?.previousName, status: folded[0]?.status, releases: folded[0]?.releases, removed: folded[0]?.params.removed },
      { name: "c", previousName: "a", status: "renamed", releases: [4, 5], removed: ["x"] },
    );
  });

  it("drops a tool added and removed before the agent saw it, and a rename undone", () => {
    assert.deepEqual(
      foldChanges([
        { release: 4, at: at(3), tools: [{ slug: "t", name: "t", status: "added", breaking: false }] },
        { release: 5, at: at(2), tools: [{ slug: "t", name: "t", status: "removed", breaking: true }] },
      ]),
      [],
    );
    assert.deepEqual(
      foldChanges([
        { release: 4, at: at(3), tools: [{ slug: "a", name: "b", previousName: "a", status: "renamed", breaking: true }] },
        { release: 5, at: at(2), tools: [{ slug: "a", name: "a", previousName: "b", status: "renamed", breaking: true }] },
      ]),
      [],
    );
  });

  it("keeps an operation that moved path as one entry, by its previous slug", () => {
    const folded = foldChanges([
      { release: 4, at: at(3), tools: [{ slug: "get-v1-orders", name: "orders.list", status: "changed", breaking: false, description: true }] },
      { release: 5, at: at(2), tools: [{ slug: "get-v2-orders", previousSlug: "get-v1-orders", name: "orders.list", status: "changed", breaking: true, params: { removed: ["page"] } }] },
    ]);
    assert.equal(folded.length, 1);
    assert.equal(folded[0]?.slug, "get-v2-orders");
    assert.equal(folded[0]?.breaking, true);
  });

  it("keeps notes short, and the listing's notes inside their budget", () => {
    const long = foldChanges([
      {
        release: 9,
        at: at(1),
        tools: [{ slug: "x", name: "x", status: "changed", breaking: true, params: { removed: Array.from({ length: 40 }, (_, i) => `field_${i}`) } }],
      },
    ]);
    assert.ok(changeNote(long[0]!).length <= CHANGE_NOTE_MAX);
    const many = foldChanges([
      {
        release: 9,
        at: at(1),
        tools: Array.from({ length: 200 }, (_, i) => ({ slug: `s${i}`, name: `t${i}`, status: "changed" as const, breaking: i % 2 === 0, params: { removed: ["a_long_parameter_name", "another_long_one"] } })),
      },
    ]);
    const notes = [...changeNotes(many).values()];
    assert.ok(notes.reduce((n, entry) => n + entry.note.length, 0) <= CHANGE_NOTES_BUDGET + 200 * 80);
    assert.ok(notes.some((entry) => entry.note.includes("Changed since you last connected")));
  });
});

describe("oldNameAnswer", () => {
  const current = (name: string) => MANIFEST.tools.find((t) => t.name === name);

  it("points a renamed tool at its new name, with what it requires", () => {
    const answer = oldNameAnswer(CHANGES, "list_orders", current);
    assert.equal(answer?.structured["code"], "tool_renamed");
    assert.equal(answer?.structured["replacement"], "find_orders");
    assert.match(answer?.text ?? "", /renamed to find_orders in release 3.*requires: limit/);
  });

  it("says a removed tool is gone, and knows nothing of a name never served", () => {
    assert.equal(oldNameAnswer(CHANGES, "legacy_report", current)?.structured["code"], "tool_removed");
    assert.equal(oldNameAnswer(CHANGES, "made_up", current), undefined);
  });
});

describe("the server", () => {
  it("puts a note on each changed tool, under any other note, and lists what_changed", async () => {
    const { client } = await connect({ changes: { since: 1 } });
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.match(byName.get("find_orders")?.description ?? "", /^\[Changed, breaking\] Since you last connected: renamed from list_orders; removed: status; new required: limit\./);
    assert.match(byName.get("carts")?.description ?? "", /^\[Changed\] .*description updated/);
    assert.match(byName.get("reports")?.description ?? "", /^\[New\]/);
    assert.equal(byName.get("payments")?.description, "payments description.");
    assert.deepEqual((byName.get("find_orders")?._meta as Record<string, unknown>)["dev.octri/changes"], {
      status: "renamed",
      breaking: true,
      releases: [3],
      previousName: "list_orders",
    });
    const whatChanged = byName.get("what_changed");
    assert.ok(whatChanged !== undefined);
    assert.match(whatChanged.description ?? "", /1 removed \(legacy_report\)/);
    await client.close();
  });

  it("answers what_changed for the session, for a given since, and for some tools", async () => {
    const { client } = await connect({ changes: { since: 2 } });
    const session = await client.callTool({ name: "what_changed", arguments: {} });
    assert.match(text(session), /since release 2 \(when you last connected\), up to release 3 \(API 1\.5\.0\)/);
    assert.match(text(session), /list_orders -> find_orders \(renamed, breaking, release 3\)/);
    assert.doesNotMatch(text(session), /legacy_report/);
    const all = await client.callTool({ name: "what_changed", arguments: { since: "1" } });
    assert.match(text(all), /legacy_report \(removed, breaking, release 2\): no longer offered/);
    const some = await client.callTool({ name: "what_changed", arguments: { since: "1", tools: ["list_orders"], breakingOnly: true } });
    const structured = some.structuredContent as { tools: { name: string }[]; from: number; to: number };
    assert.deepEqual(structured.tools.map((t) => t.name), ["find_orders"]);
    assert.equal(structured.from, 1);
    const bad = await client.callTool({ name: "what_changed", arguments: { since: "soon" } });
    assert.equal(bad.isError, true);
    await client.close();
  });

  it("tells a call to an old name where the tool went, directly and through call_tool", async () => {
    const { client } = await connect({ changes: { since: 1 } });
    const direct = await client.callTool({ name: "list_orders", arguments: { status: "open" } });
    assert.equal(direct.isError, true);
    assert.equal((direct.structuredContent as Record<string, unknown>)["replacement"], "find_orders");
    const removed = await client.callTool({ name: "legacy_report", arguments: {} });
    assert.match(text(removed), /removed in release 2/);
    const unknown = await client.callTool({ name: "made_up", arguments: {} });
    assert.equal(text(unknown), "Unknown tool: made_up");
    await client.close();

    const search = await connect({ manifest: { ...MANIFEST, toolMode: "search" }, changes: { since: 1 } });
    const via = await search.client.callTool({ name: "call_tool", arguments: { name: "list_orders", arguments: {} } });
    assert.equal((via.structuredContent as Record<string, unknown>)["code"], "tool_renamed");
    await search.client.close();
  });

  it("marks changed tools in search results and in describe_tool", async () => {
    const { client } = await connect({ manifest: { ...MANIFEST, toolMode: "search" }, changes: { since: 1 } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("what_changed"));
    const found = await client.callTool({ name: "search_tools", arguments: { query: "orders" } });
    assert.match(text(found), /find_orders .*changed since you last connected \(breaking\)/);
    const described = await client.callTool({ name: "describe_tool", arguments: { names: ["find_orders"] } });
    assert.match(text(described), /\[Changed, breaking\]/);
    await client.close();
  });

  it("with nothing known, tells of the last 14 days only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const whatChanged = tools.find((t) => t.name === "what_changed");
    assert.doesNotMatch(whatChanged?.description ?? "", /legacy_report/);
    assert.match(tools.find((t) => t.name === "find_orders")?.description ?? "", /^\[Changed, breaking\]/);
    await client.close();
  });

  it("reports the release it showed once, and asks for a new listing when the release moves", async () => {
    const seen: number[] = [];
    const { client, source, listChanged } = await connect({ changes: { since: 1, onSeen: (r) => seen.push(r) } });
    await client.listTools();
    await client.listTools();
    assert.deepEqual(seen, [3]);
    source.manifest = { ...MANIFEST, changes: { release: 4, history: [...HISTORY, { release: 4, at: at(0), tools: [] }] } };
    await client.callTool({ name: "payments", arguments: { limit: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(listChanged.length, 1);
    await client.close();
  });

  it("says nothing of tools this user may not see", async () => {
    const env = { prefix: "ACME", vars: { ACME_DENY_TOOLS: "find_orders" } };
    const { client } = await connect({ env, permissions: loadUserPermissions([], env), changes: { since: 1 } });
    const answer = await client.callTool({ name: "what_changed", arguments: {} });
    assert.doesNotMatch(text(answer), /find_orders/);
    const old = await client.callTool({ name: "list_orders", arguments: {} });
    assert.doesNotMatch(text(old), /find_orders/);
    await client.close();
  });

  it("serves none of it when turned off, or when the manifest has no history", async () => {
    for (const options of [
      { env: { prefix: "ACME", vars: { ACME_CHANGE_NOTICES: "0" } } },
      { changes: false as const },
      { manifest: (({ changes: _changes, ...rest }) => rest)(MANIFEST) },
    ]) {
      const { client } = await connect(options);
      const { tools } = await client.listTools();
      assert.ok(!tools.some((t) => t.name === "what_changed"));
      assert.equal(tools.find((t) => t.name === "find_orders")?.description, "find_orders description.");
      await client.close();
    }
  });

  it("marks a chained tool whose step changed", async () => {
    const chain: ChainTool = {
      slug: "checkout",
      name: "checkout",
      description: "Checks out.",
      inputSchema: { type: "object", properties: {}, required: [] },
      steps: [{ id: "a", tool: tool("carts"), inputs: {} }],
      policy: "auto",
      readOnly: true,
      destructive: false,
    } as ChainTool;
    const changes: ToolChanges = {
      release: 2,
      history: [
        { release: 1, at: at(5), tools: [] },
        { release: 2, at: at(1), tools: [{ slug: "checkout", kind: "chain", name: "checkout", status: "changed", breaking: true, steps: ["carts"] }] },
      ],
    };
    const { client } = await connect({ manifest: { ...MANIFEST, chains: [chain], changes }, changes: { since: 1 } });
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "checkout")?.description ?? "", /^\[Changed, breaking\] .*steps changed: carts/);
    await client.close();
  });
});

describe("localChangeState", () => {
  it("remembers the last release per project and group, and can be turned off", () => {
    const dir = mkdtempSync(join(tmpdir(), "octri-changes-"));
    try {
      const env = { prefix: "ACME", vars: { ACME_STATE_DIR: dir } };
      const first = localChangeState(env, { projectId: "p1" });
      assert.equal(first?.since, null);
      first?.onSeen(7);
      assert.equal(localChangeState(env, { projectId: "p1" })?.since, 7);
      assert.equal(localChangeState(env, { projectId: "p1", group: "reads" })?.since, null);
      assert.equal(JSON.parse(readFileSync(join(dir, "changes.json"), "utf8"))["p1"].release, 7);
      assert.equal(localChangeState({ prefix: "ACME", vars: { ACME_STATE_DIR: dir, ACME_CHANGE_NOTICES: "0" } }, { projectId: "p1" }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unreadable file as nothing known", () => {
    const dir = mkdtempSync(join(tmpdir(), "octri-changes-"));
    try {
      writeFileSync(join(dir, "changes.json"), "{not json");
      const env = { prefix: "ACME", vars: { ACME_STATE_DIR: dir } };
      assert.equal(localChangeState(env, { projectId: "p1" })?.since, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
