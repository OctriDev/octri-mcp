import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildErrorGuide,
  createServer,
  credentialVarNames,
  ERROR_GUIDE_MAX_CHARS,
  loadUserPermissions,
  retryAfterSeconds,
} from "./core.js";

import type {
  ChainTool,
  CreateServerOptions,
  ErrorGuideInput,
  OperationTool,
  OutageStatus,
  StatusSource,
  ToolManifest,
} from "./core.js";

// Error guides: what a failed call tells the agent to fix. Units for each layer
// and status class, then the server end to end over the SDK's in-memory
// transport against a local upstream that fails on demand.

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

const listPets = tool("listPets", "GET", "/pets");
const getPet = tool("getPet", "GET", "/pets/{petId}", {
  inputSchema: { type: "object", properties: { pet_id: { type: "string" } }, required: ["pet_id"] },
  http: { method: "GET", path: "/pets/{petId}", pathParams: [{ name: "pet_id", wireName: "petId" }], queryParams: [], bodyParams: [], constants: [] },
});
const createPet = tool("createPet", "POST", "/pets", {
  inputSchema: {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          email: { type: "string", format: "email" },
          species: { type: "string", enum: ["dog", "cat"] },
        },
        required: ["name", "species"],
      },
    },
    required: ["body"],
  },
  http: {
    method: "POST",
    path: "/pets",
    pathParams: [],
    queryParams: [],
    bodyParams: [{ name: "email", wireName: "contact_email" }],
    constants: [],
  },
  errors: [{ status: "422", issue: "SPECIES_UNSUPPORTED", scenario: "The species is not one the shelter takes", field: "/species" }],
  errorHelp: { "409": "A pet with that name already exists; pick another name." },
});

const guide = (status: number, extra: Partial<ErrorGuideInput> = {}, body = "", retryAfter?: string) =>
  buildErrorGuide({
    tool: extra.tool ?? createPet,
    answer: { status, body, ...(retryAfter !== undefined ? { retryAfter } : {}) },
    origin: "env",
    credentialVars: ["OCTRI_API_KEY"],
    tools: [listPets, getPet, createPet],
    now: Date.parse("2026-10-29T12:00:00Z"),
    ...extra,
  });

describe("buildErrorGuide: layers", () => {
  it("the operation's own guide comes first", () => {
    const result = guide(409, { projectGuides: { "409": "Project 409.", "4xx": "Project 4xx." } });
    assert.match(result.text, /^How to fix this call \(409\):\nFrom the API's docs: A pet with that name already exists/);
    assert.doesNotMatch(result.text, /Project/);
    assert.equal(result.structured.source, "operation");
  });

  it("then the project's guide for the status, then for its class", () => {
    const exact = guide(404, { tool: getPet, projectGuides: { "404": "Project 404.", "4xx": "Project 4xx." } });
    assert.match(exact.text, /From the API's docs: Project 404\./);
    assert.equal(exact.structured.source, "project");
    const byClass = guide(410, { tool: getPet, projectGuides: { "404": "Project 404.", "4xx": "Project 4xx." } });
    assert.match(byClass.text, /From the API's docs: Project 4xx\./);
  });

  it("falls back to the built-in hint per status class only when the docs are silent", () => {
    const cases: [number, RegExp][] = [
      [400, /rejected the arguments/],
      [422, /rejected the arguments/],
      [404, /Nothing was found at that address/],
      [409, /conflicts with the resource's current state/],
      [415, /method or content type/],
      [429, /Rate limited/],
      [500, /failed on its side/],
      [418, /refused the request/],
    ];
    for (const [status, expected] of cases) {
      const result = guide(status, { tool: listPets });
      assert.match(result.text, expected, `status ${status}`);
      assert.equal(result.structured.source, "built_in");
    }
    assert.doesNotMatch(guide(404, { tool: getPet, projectGuides: { "404": "Docs." } }).text, /Nothing was found/);
  });

  it("warns that a failed write may have taken effect", () => {
    assert.match(guide(500).text, /This was a POST: check whether it took effect/);
    // Whatever the docs say: a blind retry of a write can do it twice.
    assert.match(guide(500, { projectGuides: { "5xx": "See status.example.com." } }).text, /See status\.example\.com\.\nThis was a POST/);
    assert.doesNotMatch(guide(500, { tool: listPets }).text, /took effect/);
  });

  it("points a 404 at the tool that lists valid ids", () => {
    assert.match(guide(404, { tool: getPet }).text, /To find a valid `pet_id`, call `listPets` first\./);
    assert.doesNotMatch(guide(404, { tool: getPet, tools: [getPet] }).text, /call `listPets`/);
  });
});

describe("buildErrorGuide: the error body", () => {
  const shapes: [string, unknown, string][] = [
    ["field + message", { message: "invalid", field: "email" }, "body.email"],
    ["JSON:API pointer", { errors: [{ detail: "bad", source: { pointer: "/data/attributes/species" } }] }, "body.species"],
    ["FastAPI loc", { detail: [{ loc: ["body", "name"], msg: "field required" }] }, "body.name"],
    ["Stripe param", { error: { type: "invalid_request_error", param: "species" } }, "body.species"],
    ["errors map", { errors: { name: ["can't be blank"] } }, "body.name"],
    ["wire name binding", { errors: [{ field: "contact_email", message: "bad" }] }, "body.email"],
    ["path param", { error: "not_found", details: [{ field: "petId" }] }, "pet_id"],
  ];
  for (const [label, body, argument] of shapes) {
    it(`points at the argument: ${label}`, () => {
      const result = guide(422, argument === "pet_id" ? { tool: getPet } : {}, JSON.stringify(body));
      assert.equal(result.structured.field, argument);
      assert.match(result.text, new RegExp(`argument \`${argument.replace(".", "\\.")}\``));
    });
  }

  it("describes what the argument accepts", () => {
    const result = guide(422, {}, JSON.stringify({ field: "species", message: "bad" }));
    assert.match(result.text, /argument `body\.species` \(string, one of "dog", "cat", required\)/);
  });

  it("names a documented error code with its scenario and field", () => {
    const result = guide(422, {}, JSON.stringify({ code: "SPECIES_UNSUPPORTED" }));
    assert.match(result.text, /Documented error 422 SPECIES_UNSUPPORTED: The species is not one the shelter takes\./);
    assert.equal(result.structured.code, "SPECIES_UNSUPPORTED");
    assert.equal(result.structured.field, "body.species");
  });

  it("matches nothing in a body it cannot read", () => {
    const result = guide(422, {}, "<html>oops</html>");
    assert.equal(result.structured.field, undefined);
    assert.match(result.text, /rejected the arguments/);
  });
});

describe("buildErrorGuide: credentials", () => {
  const cases: [ErrorGuideInput["origin"], 401 | 403, RegExp][] = [
    ["env", 401, /refused the credential in OCTRI_API_KEY/],
    ["none", 401, /No API credential is set.*OCTRI_API_KEY/],
    ["keychain", 401, /saved in the system keychain.*`login`/],
    ["stored", 401, /key the project owner stored for this installation.*updating in Octri/],
    ["signin", 401, /signed-in session.*reconnect this MCP server/],
    ["client", 401, /this MCP client sends.*key configured for this server in their client/],
    ["signin", 403, /signed-in account is not allowed/],
    ["stored", 403, /stored for this installation is not allowed/],
    ["env", 403, /valid but not allowed/],
  ];
  for (const [origin, status, expected] of cases) {
    it(`${status} with a ${origin} credential says who can fix it`, () => {
      const result = guide(status, { origin, tool: listPets });
      assert.match(result.text, expected);
      if (status === 401) assert.match(result.text, /Changing the arguments will not help|No API credential/);
    });
  }

  it("keeps the docs' word and adds who can fix it", () => {
    const result = guide(401, { origin: "signin", tool: listPets, projectGuides: { "401": "Tokens last an hour." } });
    assert.match(result.text, /From the API's docs: Tokens last an hour\.\n.*reconnect/);
  });

  it("names the variables for each scheme", () => {
    assert.deepEqual(credentialVarNames("bearer", "ACME"), ["ACME_API_TOKEN"]);
    assert.deepEqual(credentialVarNames("apiKey", "ACME"), ["ACME_API_KEY"]);
    assert.deepEqual(credentialVarNames("basic", "ACME"), ["ACME_API_USERNAME", "ACME_API_PASSWORD"]);
    assert.deepEqual(credentialVarNames("none", "ACME"), []);
  });
});

describe("buildErrorGuide: rate limits and size", () => {
  it("reads Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    assert.equal(retryAfterSeconds("120", now), 120);
    assert.equal(retryAfterSeconds("Thu, 29 Oct 2026 12:05:00 GMT", now), 300);
    assert.equal(retryAfterSeconds("soon", now), undefined);
    assert.equal(retryAfterSeconds("999999999", now), 86400);
  });

  it("a 429 waits for Retry-After, and says so in data", () => {
    const result = guide(429, { tool: listPets }, "", "30");
    assert.match(result.text, /do not retry before 2026-10-29T12:00:30\.000Z \(30 s\)/);
    assert.equal(result.structured.retryAfterSeconds, 30);
    assert.equal(result.structured.retryAfter, "2026-10-29T12:00:30.000Z");
    assert.match(guide(429, { tool: listPets }).text, /No Retry-After was sent/);
  });

  it("never grows past the cap", () => {
    const long = "word ".repeat(400);
    const result = guide(409, { tool: { ...createPet, errorHelp: { "409": long } } }, JSON.stringify({ field: "name" }));
    assert.ok(result.text.length <= ERROR_GUIDE_MAX_CHARS, `${result.text.length}`);
    assert.match(result.text, /…$/);
  });

  it("through call_tool, a rejected call carries the input schema", () => {
    assert.match(guide(422, { viaCallTool: true }).text, /\n\nInput schema for createPet: \{"type":"object"/);
    assert.doesNotMatch(guide(422).text, /Input schema/);
    assert.doesNotMatch(guide(404, { viaCallTool: true, tool: getPet }).text, /Input schema/);
  });
});

// ─── End to end ──────────────────────────────────────────────────────────────

const text = (result: unknown) =>
  ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;

describe("error guides through the server", () => {
  const SECRET = "sk_live_guide_secret_123456";
  // path → [status, body, headers]
  const answers = new Map<string, [number, string, Record<string, string>]>();
  const upstream = http.createServer((req, res) => {
    const [code, body, headers] = answers.get(`${req.method} ${req.url ?? ""}`) ?? [200, '{"ok":true}', {}];
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end(body);
  });
  let manifest: ToolManifest;
  let origin: string;
  const clients: Client[] = [];
  const monitor: StatusSource & { status: OutageStatus | null } = {
    status: null,
    async read() {
      return this.status;
    },
  };

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const adopt: ChainTool = {
      slug: "adopt",
      name: "adopt",
      description: "List pets, then create one.",
      inputSchema: { type: "object", properties: {}, required: [] },
      steps: [
        { id: "list", tool: listPets, inputs: {} },
        { id: "create", tool: createPet, inputs: { body: { name: "Rex", species: "dog" } } },
      ],
      policy: "auto",
      readOnly: false,
      destructive: false,
    };
    manifest = {
      baseUrl: `${origin}/v1`,
      auth: "apiKey",
      tools: [listPets, getPet, createPet],
      chains: [adopt],
      errorGuides: { "404": "Ids are case-sensitive.", "5xx": "Our status page is status.example.com." },
    } as unknown as ToolManifest;
  });

  beforeEach(() => {
    answers.clear();
    monitor.status = null;
  });

  after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    upstream.close();
  });

  async function connect(extra: Partial<CreateServerOptions> = {}, vars: Record<string, string> = { OCTRI_API_KEY: SECRET }) {
    const server = createServer({
      source: { kind: "static", manifest: extra.source !== undefined ? (extra.source as { manifest: ToolManifest }).manifest : manifest },
      env: { prefix: "OCTRI", vars },
      status: monitor,
      ...extra,
    });
    const client = new Client({ name: "guide-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    return client;
  }

  it("puts the guide under the request line, above the raw body, with the facts as data", async () => {
    answers.set("POST /v1/pets", [422, JSON.stringify({ errors: [{ field: "species", message: "must be dog or cat" }] }), {}]);
    const client = await connect();
    const result = await client.callTool({ name: "createPet", arguments: { body: { name: "Rex", species: "cow" } } });
    assert.equal(result.isError, true);
    const lines = text(result).split("\n\n");
    assert.match(lines[0] ?? "", /^POST http:\/\/127\.0\.0\.1:\d+\/v1\/pets → 422/);
    assert.match(lines[1] ?? "", /^How to fix this call \(422\):\n.*argument `body\.species`/s);
    assert.match(lines[2] ?? "", /must be dog or cat/);
    assert.deepEqual(result.structuredContent, {
      error: "request_failed",
      tool: "createPet",
      statusCode: 422,
      source: "built_in",
      field: "body.species",
    });
  });

  it("uses the project's guides from the manifest", async () => {
    answers.set("GET /v1/pets/abc", [404, '{"message":"no such pet"}', {}]);
    const client = await connect();
    const result = await client.callTool({ name: "getPet", arguments: { pet_id: "abc" } });
    assert.match(text(result), /From the API's docs: Ids are case-sensitive\./);
    assert.match(text(result), /call `listPets` first/);
  });

  it("redacts a credential the API echoes, in the text and the data", async () => {
    answers.set("GET /v1/pets", [401, JSON.stringify({ error: "invalid key", field: SECRET }), {}]);
    const client = await connect();
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.doesNotMatch(text(result), new RegExp(SECRET));
    assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(SECRET));
    assert.match(text(result), /refused the credential in OCTRI_API_KEY/);
  });

  it("tells the hosted caller who fixes a refused key", async () => {
    answers.set("GET /v1/pets", [401, "{}", {}]);
    const stored = await connect({ credentialOrigin: "stored" });
    assert.match(text(await stored.callTool({ name: "listPets", arguments: {} })), /stored for this installation/);
    const none = await connect({}, {});
    assert.match(text(await none.callTool({ name: "listPets", arguments: {} })), /No API credential is set, and this endpoint needs one\. Ask the user to set OCTRI_API_KEY/);
  });

  it("passes Retry-After on a 429", async () => {
    answers.set("GET /v1/pets", [429, '{"error":"slow down"}', { "Retry-After": "20" }]);
    const client = await connect();
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.match(text(result), /The API asked for a wait: do not retry before .* \(20 s\)/);
    assert.equal((result.structuredContent as Record<string, unknown>)["retryAfterSeconds"], 20);
  });

  it("a known outage wins over the 5xx guide", async () => {
    answers.set("GET /v1/pets", [503, '{"error":"down"}', {}]);
    const now = Date.now();
    monitor.status = {
      enabled: true,
      available: true,
      origin,
      operations: {
        [listPets.slug]: {
          state: "down",
          since: new Date(now - 600_000).toISOString(),
          checkedAt: new Date(now - 60_000).toISOString(),
          nextCheckAt: new Date(now + 240_000).toISOString(),
          staleAt: new Date(now + 600_000).toISOString(),
          statusCode: 503,
          reason: "status",
        },
      },
    };
    const client = await connect();
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.match(text(result), /^Known outage/);
    assert.doesNotMatch(text(result), /How to fix this call/);
    assert.equal((result.structuredContent as Record<string, unknown>)["error"], "known_outage");

    // Without the monitor's word, the same 503 gets the guide, project wording first.
    monitor.status = null;
    const raw = await client.callTool({ name: "listPets", arguments: {} });
    assert.match(text(raw), /How to fix this call \(503\):\nFrom the API's docs: Our status page is status\.example\.com\./);
  });

  it("guides a chain's failing step", async () => {
    answers.set("POST /v1/pets", [409, '{"code":"DUPLICATE"}', {}]);
    // A chain that writes asks first; this client cannot answer, so it is pre-approved.
    const client = await connect({ permissions: loadUserPermissions(["--allow-tools", "custom:adopt"], {}) });
    const result = await client.callTool({ name: "adopt", arguments: {} });
    assert.match(text(result), /^Step 2 of 2 \(create: POST \/pets\) failed\./);
    assert.match(text(result), /How to fix step createPet \(409\):\nFrom the API's docs: A pet with that name already exists/);
    assert.equal((result.structuredContent as Record<string, unknown>)["step"], "createPet");
  });

  it("guides call_tool in search mode, schema included for a rejected call", async () => {
    answers.set("POST /v1/pets", [400, '{"param":"name"}', {}]);
    const client = await connect({ toolMode: "search" });
    const result = await client.callTool({
      name: "call_tool",
      arguments: { name: "createPet", arguments: { body: { name: " ", species: "dog" } } },
    });
    assert.match(text(result), /How to fix this call \(400\):\n.*argument `body\.name` \(string, min length 1, required\)/s);
    assert.match(text(result), /Input schema for createPet: /);
  });

  it("leaves pre-send argument errors as they were", async () => {
    const client = await connect({ toolMode: "search" });
    const result = await client.callTool({ name: "call_tool", arguments: { name: "getPet", arguments: {} } });
    assert.match(text(result), /missing required argument: pet_id/);
    assert.doesNotMatch(text(result), /How to fix/);
    assert.equal(result.structuredContent, undefined);
  });

  it("turns off with OCTRI_ERROR_GUIDES=0", async () => {
    answers.set("GET /v1/pets", [400, "{}", {}]);
    const client = await connect({}, { OCTRI_API_KEY: SECRET, OCTRI_ERROR_GUIDES: "0" });
    const result = await client.callTool({ name: "listPets", arguments: {} });
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /How to fix/);
    assert.equal(result.structuredContent, undefined);
  });
});
