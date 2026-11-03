import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  createServer,
  loadUserPermissions,
  narrowToGroup,
  parseRef,
  resolveTemplate,
  runChain,
  UsageReporter,
} from "./core.js";

import type { ChainTool, CreateServerOptions, OperationTool, ToolManifest } from "./core.js";

// Chained tools, prompts and resources: owner-authored MCP content served
// beside the operation tools. A chain sends real requests one after another, so
// every limit a direct call has (off, deny, read-only, approval, dry run,
// usage) must hold for it too.

function op(name: string, method: string, path: string, extra: Partial<OperationTool> = {}): OperationTool {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1] ?? "", wireName: m[1] ?? "" }));
  const body = method !== "GET";
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
      },
      required: pathParams.map((p) => p.name),
    },
    http: { method, path, pathParams, queryParams: [], bodyParams: [], constants: [] },
    policy: body ? "confirm" : "auto",
    ...extra,
  };
}

const createCustomer = op("createCustomer", "POST", "/customers");
const createInvoice = op("createInvoice", "POST", "/customers/{customerId}/invoices");
const getCustomer = op("getCustomer", "GET", "/customers/{customerId}");

const onboard: ChainTool = {
  slug: "onboard",
  name: "onboard_customer",
  description: "Create a customer and invoice them.",
  inputSchema: {
    type: "object",
    properties: { email: { type: "string" }, amount: { type: "integer" } },
    required: ["email", "amount"],
  },
  steps: [
    { id: "create", tool: createCustomer, inputs: { body: { email: "{{args.email}}" } } },
    {
      id: "invoice",
      tool: createInvoice,
      inputs: { customerId: "{{steps.create.body.id}}", body: { amount: "{{args.amount}}", note: "For {{args.email}}" } },
    },
  ],
  output: { customer: "{{steps.create.body.id}}", invoice: "{{steps.invoice.body.id}}", status: "{{steps.invoice.status}}" },
  policy: "confirm",
  readOnly: false,
  destructive: true,
  tags: ["billing"],
};

const lookup: ChainTool = {
  slug: "lookup",
  name: "lookup_twice",
  description: "Read a customer, then read it again by the id it returned.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  steps: [
    { id: "first", tool: getCustomer, inputs: { customerId: "{{args.id}}" } },
    { id: "second", tool: getCustomer, inputs: { customerId: "{{steps.first.body.id}}" } },
  ],
  policy: "auto",
  readOnly: true,
  destructive: false,
};

describe("references", () => {
  it("parse the same grammar as the publish check", () => {
    assert.deepEqual(parseRef("steps.a.body.items[0][\"x.y\"]"), { root: "steps", step: "a", part: "body", path: ["items", 0, "x.y"] });
    for (const bad of ["env.X", "args.a | b", "args.items[*]", "steps.a", "steps.a.headers", "steps.a.status.x", "args..x"]) {
      assert.ok("error" in parseRef(bad), bad);
    }
  });

  it("keep a whole reference's type, write an embedded one into text, and drop one that leads nowhere", () => {
    const scope = { args: { n: 5, o: { a: 1 } }, steps: new Map([["s", { status: 201, body: { id: "x", list: [{ v: true }] } }]]) };
    assert.deepEqual(
      resolveTemplate(
        { n: "{{args.n}}", text: "id={{steps.s.body.id}} n={{args.n}}", deep: "{{steps.s.body.list[0].v}}", gone: "{{args.missing}}", obj: "{{args.o}}", st: "{{steps.s.status}}" },
        { scope },
      ),
      { n: 5, text: "id=x n=5", deep: true, obj: { a: 1 }, st: 201 },
    );
  });

  it("never walk the prototype", () => {
    const scope = { args: {}, steps: new Map() };
    assert.equal(resolveTemplate("{{args.constructor}}", { scope }), undefined);
    assert.equal(resolveTemplate("{{args.__proto__}}", { scope }), undefined);
  });
});

describe("chained tools on a server", () => {
  const seen: string[] = [];
  const bodies: string[] = [];
  const octriSeen: string[] = [];
  let slowMs = 0;
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";
      // The fake Octri API, for resource contents.
      if (url.startsWith("/api/v1/public/mcp/")) {
        octriSeen.push(url);
        if (url.endsWith("/resources/spec")) {
          res.end(JSON.stringify({ uri: "docs://openapi.json", mimeType: "application/json", text: '{"openapi":"3.1.0"}' }));
        } else {
          res.statusCode = 404;
          res.end('{"error":{"message":"not found"}}');
        }
        return;
      }
      seen.push(`${req.method} ${url}`);
      bodies.push(raw);
      const reply = () => {
        if (req.method === "POST" && url === "/customers") {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: "cus_1" }));
        } else if (req.method === "POST" && url === "/customers/cus_1/invoices") {
          const amount = (JSON.parse(raw) as { amount: number }).amount;
          res.statusCode = amount < 0 ? 422 : 201;
          res.end(amount < 0 ? '{"error":"NEGATIVE_AMOUNT"}' : JSON.stringify({ id: "inv_1", amount }));
        } else if (req.method === "GET" && url.startsWith("/customers/")) {
          res.end(JSON.stringify({ id: "cus_9" }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      };
      if (slowMs > 0) setTimeout(reply, slowMs);
      else reply();
    });
  });
  let manifest: ToolManifest;
  let octri: { apiUrl: string; projectId: string };

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    octri = { apiUrl: `${origin}/api/v1`, projectId: "p1" };
    manifest = {
      baseUrl: origin,
      auth: "none",
      tools: [createCustomer, createInvoice, getCustomer],
      chains: [onboard, lookup],
      prompts: [
        {
          slug: "bill",
          name: "bill_customer",
          description: "Create a customer and invoice them.",
          arguments: [{ name: "email", required: true }, { name: "amount" }],
          messages: [{ role: "user", text: "Create a customer for {{args.email}} and invoice {{args.amount}}. \\{{literal}}" }],
        },
      ],
      resources: [
        { slug: "spec", uri: "docs://openapi.json", name: "OpenAPI spec", mimeType: "application/json" },
        { slug: "gone", uri: "docs://guides/gone", name: "Gone", mimeType: "text/markdown" },
      ],
      groups: [
        // Lists the chain but none of its endpoints: the chain carries its own.
        { slug: "onboarding", name: "Onboarding", docs: false, tools: [], chains: ["onboard"], prompts: ["bill"], resources: [] },
        // A group from before chained tools: lists none.
        { slug: "old", name: "Old", docs: false, tools: ["slug-getCustomer"] },
      ],
    };
  });

  after(() => {
    upstream.close();
  });

  const prompts: string[] = [];
  async function connect(options: Partial<CreateServerOptions>, approval?: "accept" | "decline"): Promise<Client> {
    const server = createServer({
      source: { kind: "static", manifest, octri },
      env: { prefix: "OCTRI", vars: {} },
      ...options,
    });
    const client = new Client(
      { name: "chains-test", version: "1" },
      { capabilities: approval === undefined ? {} : { elicitation: {} } },
    );
    if (approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(String(request.params.message));
        return { action: approval, content: {} };
      });
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  const ops = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).filter((n) => !/^(search|get|list)_/.test(n));
  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { text: string }[])[0]?.text ?? "";

  it("lists chained tools after the operation tools, with hints read off their steps", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).slice(-5), ["createCustomer", "createInvoice", "getCustomer", "onboard_customer", "lookup_twice"]);
    const chain = tools.find((t) => t.name === "onboard_customer");
    assert.match(chain?.description ?? "", /asks the user to approve/);
    assert.deepEqual(chain?.annotations, { title: "onboard_customer", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    assert.equal(tools.find((t) => t.name === "lookup_twice")?.annotations?.readOnlyHint, true);
    await client.close();
  });

  it("asks once, listing both requests, then passes the id from step one to step two", async () => {
    prompts.length = 0;
    const client = await connect({}, "accept");
    const before = seen.length;
    const result = await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 40 } });
    assert.notEqual(result.isError, true, text(result));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Allow onboard_customer to call your API\? It sends 2 requests/);
    assert.match(prompts[0] ?? "", /1\. createCustomer: POST http:\/\/127\.0\.0\.1:\d+\/customers/);
    assert.match(prompts[0] ?? "", /2\. createInvoice: POST http:\/\/127\.0\.0\.1:\d+\/customers\/\{steps\.create\.body\.id\}\/invoices/);
    assert.match(prompts[0] ?? "", /"amount":40,"note":"For a@b\.co"/);
    assert.deepEqual(seen.slice(before), ["POST /customers", "POST /customers/cus_1/invoices"]);
    assert.deepEqual(JSON.parse(bodies.at(-1) ?? "{}"), { amount: 40, note: "For a@b.co" });
    assert.deepEqual(JSON.parse(text(result)), { customer: "cus_1", invoice: "inv_1", status: 201 });
    await client.close();
  });

  it("sends nothing when the person declines", async () => {
    const client = await connect({}, "decline");
    const before = seen.length;
    const result = await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 40 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /declined onboard_customer\. Nothing was sent/);
    assert.equal(seen.length, before);
    await client.close();
  });

  it("refuses to run an ask-first chain on a client that cannot ask, unless pre-approved", async () => {
    const client = await connect({});
    const before = seen.length;
    const blocked = await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 40 } });
    assert.match(text(blocked), /OCTRI_ALLOW_TOOLS=onboard_customer/);
    assert.equal(seen.length, before);
    await client.close();

    const allowed = await connect({ permissions: loadUserPermissions(["--allow-tools", "custom:onboard"], {}) });
    assert.notEqual((await allowed.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 1 } })).isError, true);
    assert.equal(seen.length, before + 2);
    await allowed.close();
  });

  it("runs a read-only chain without asking", async () => {
    const client = await connect({});
    const before = seen.length;
    const result = await client.callTool({ name: "lookup_twice", arguments: { id: "cus_1" } });
    assert.deepEqual(JSON.parse(text(result)), { id: "cus_9" });
    assert.deepEqual(seen.slice(before), ["GET /customers/cus_1", "GET /customers/cus_9"]);
    await client.close();
  });

  it("stops at the first failing step and says what was already sent", async () => {
    const client = await connect({ permissions: loadUserPermissions(["--allow-tools", "*"], {}) });
    const result = await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: -1 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /^Step 2 of 2 \(invoice: POST \/customers\/\{customerId\}\/invoices\) failed\. POST .* → 422/);
    assert.match(text(result), /NEGATIVE_AMOUNT/);
    assert.match(text(result), /Already sent, and not undone: step 1 create 201\./);
    await client.close();
  });

  it("refuses a missing argument before asking or sending", async () => {
    prompts.length = 0;
    const client = await connect({}, "accept");
    const before = seen.length;
    const result = await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co" } });
    assert.match(text(result), /missing required argument: amount/);
    assert.equal(prompts.length, 0);
    assert.equal(seen.length, before);
    await client.close();
  });

  it("returns every planned request in a dry run and sends none, reads included", async () => {
    const client = await connect({ permissions: loadUserPermissions(["--dry-run"], {}) });
    const before = seen.length;
    const result = await client.callTool({ name: "lookup_twice", arguments: { id: "cus_1" } });
    assert.match(text(result), /^Dry run: lookup_twice would send 2 requests in this order\. None was sent\./);
    assert.match(text(result), /2\. getCustomer: GET http:\/\/127\.0\.0\.1:\d+\/customers\/\{steps\.first\.body\.id\}/);
    assert.equal(seen.length, before);
    await client.close();
  });

  it("hides a chain whose step the user denied or that writes under read-only", async () => {
    const denyStep = await connect({ permissions: loadUserPermissions(["--deny-tools", "createInvoice"], {}) });
    assert.ok(!(await ops(denyStep)).includes("onboard_customer"));
    const refused = await denyStep.callTool({ name: "onboard_customer", arguments: { email: "a", amount: 1 } });
    assert.match(text(refused), /one of its steps is off/);
    await denyStep.close();

    const denyChain = await connect({ permissions: loadUserPermissions(["--deny-tools", "custom:lookup"], {}) });
    assert.ok(!(await ops(denyChain)).includes("lookup_twice"));
    await denyChain.close();

    const readOnly = await connect({ permissions: loadUserPermissions(["--read-only"], {}) });
    assert.deepEqual(await ops(readOnly), ["getCustomer", "lookup_twice"]);
    await readOnly.close();
  });

  it("serves a group's chain even when the group lists none of its endpoints", async () => {
    const client = await connect({ group: "onboarding" }, "accept");
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["onboard_customer"]);
    assert.notEqual((await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 2 } })).isError, true);
    assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name), ["bill_customer"]);
    await client.close();

    const old = await connect({ group: "old" });
    assert.deepEqual((await old.listTools()).tools.map((t) => t.name), ["getCustomer"]);
    assert.deepEqual((await old.listPrompts()).prompts, []);
    await old.close();
    assert.deepEqual(narrowToGroup(manifest, "old").chains, []);
  });

  it("reports the chain once and each request it sent, marked with the chain", async () => {
    const sent: string[] = [];
    const reporter = new UsageReporter(octri.apiUrl, async (_url, body) => {
      sent.push(body);
    });
    const client = await connect({ reporter }, "accept");
    await client.callTool({ name: "onboard_customer", arguments: { email: "a@b.co", amount: 3 } });
    await reporter.flush();
    const events = (JSON.parse(sent[0] ?? "{}") as { events: Record<string, unknown>[] }).events;
    assert.deepEqual(
      events.map((e) => [e["tool"], e["slug"], e["chain"], e["outcome"]]),
      [
        ["createCustomer", "slug-createCustomer", "onboard", "ok"],
        ["createInvoice", "slug-createInvoice", "onboard", "ok"],
        ["onboard_customer", "custom:onboard", undefined, "ok"],
      ],
    );
    await client.close();
  });

  it("gives up when the whole chain runs out of time", async () => {
    slowMs = 200;
    try {
      const result = await runChain(lookup, manifest, { id: "cus_1" }, { env: { prefix: "OCTRI", vars: {} }, timeoutMs: 50 });
      assert.equal(result.ok, false);
      assert.match(result.text, /^Step 1 of 2 \(first: GET .*\) failed\. The request did not complete/);
    } finally {
      slowMs = 0;
    }
  });

  it("fails closed on a mapping the publish check would have refused", async () => {
    const bad: ChainTool = { ...lookup, steps: [{ id: "x", tool: getCustomer, inputs: { customerId: "{{env.SECRET}}" } }] };
    const result = await runChain(bad, manifest, { id: "1" }, { env: { prefix: "OCTRI", vars: {} } });
    assert.equal(result.ok, false);
    assert.match(result.text, /bad reference/);
  });

  it("serves prompts with their arguments filled in", async () => {
    const client = await connect({});
    const { prompts: listed } = await client.listPrompts();
    assert.deepEqual(listed, [
      {
        name: "bill_customer",
        description: "Create a customer and invoice them.",
        arguments: [{ name: "email", required: true }, { name: "amount" }],
      },
    ]);
    const got = await client.getPrompt({ name: "bill_customer", arguments: { email: "a@b.co" } });
    assert.deepEqual(got.messages, [
      { role: "user", content: { type: "text", text: "Create a customer for a@b.co and invoice . {{literal}}" } },
    ]);
    await assert.rejects(client.getPrompt({ name: "bill_customer", arguments: {} }), /needs the argument email/);
    await assert.rejects(client.getPrompt({ name: "nope" }), /Unknown prompt: nope/);
    await client.close();
  });

  it("leaves out the prompts a plugin ships as commands, from the list and from get", async () => {
    const client = await connect({ skipPrompts: new Set(["bill_customer"]) });
    assert.deepEqual((await client.listPrompts()).prompts, []);
    await assert.rejects(client.getPrompt({ name: "bill_customer", arguments: { email: "a@b.co" } }), /Unknown prompt: bill_customer/);
    await client.close();
  });

  it("lists resources and reads their contents from the Octri project", async () => {
    const client = await connect({});
    assert.deepEqual((await client.listResources()).resources.map((r) => [r.uri, r.mimeType]), [
      ["docs://openapi.json", "application/json"],
      ["docs://guides/gone", "text/markdown"],
    ]);
    const read = await client.readResource({ uri: "docs://openapi.json" });
    assert.deepEqual(read.contents, [{ uri: "docs://openapi.json", mimeType: "application/json", text: '{"openapi":"3.1.0"}' }]);
    assert.equal(octriSeen.at(-1), "/api/v1/public/mcp/p1/resources/spec");
    await assert.rejects(client.readResource({ uri: "docs://guides/gone" }));
    await assert.rejects(client.readResource({ uri: "docs://other" }), /Unknown resource/);
    await client.close();
  });

  it("serves no resources without an Octri project to read them from", async () => {
    const server = createServer({ source: { kind: "static", manifest }, env: { prefix: "OCTRI", vars: {} } });
    const client = new Client({ name: "t", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    assert.deepEqual((await client.listResources()).resources, []);
    await client.close();
  });
});
