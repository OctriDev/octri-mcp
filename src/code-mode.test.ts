import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  codeModeTools,
  createServer,
  DEFAULT_SANDBOX_LIMITS,
  DESCRIBE_SDK,
  noUserLimits,
  nodeCodeSandbox,
  PRACTICE_HEADER,
  RUN_CODE,
  type CallEvent,
  type CodeModeManifest,
  type CodeSandbox,
  type CreateServerOptions,
  type OperationTool,
  type PracticeData,
  type ToolManifest,
  type UsageReporter,
} from "./core.js";

// Code mode through the MCP server: the official SDK client over the in-memory
// transport, scripts on real worker threads, and a real HTTP upstream on
// loopback. Every SDK call a script makes must go through the same gates as a
// tool call: approval prompts, permissions, redaction, usage, practice.

function op(name: string, method: string, path: string, extra: Partial<OperationTool> = {}): OperationTool {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1] ?? "", wireName: m[1] ?? "" }));
  const hasBody = method === "POST" || method === "PATCH";
  const listing = method === "GET" && pathParams.length === 0;
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(pathParams.map((p) => [p.name, { type: "string" }])),
        ...(hasBody ? { body: { type: "object", properties: { name: { type: "string" }, tag: { type: "string", enum: ["dog", "cat"] } } } } : {}),
        ...(listing ? { limit: { type: "integer" } } : {}),
      },
      required: pathParams.map((p) => p.name),
    },
    http: {
      method,
      path,
      pathParams,
      queryParams: listing ? [{ name: "limit", wireName: "limit" }] : [],
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
const whoAmI = op("whoAmI", "GET", "/whoami");

const codeMode: CodeModeManifest = {
  languages: ["typescript", "python"],
  methods: {
    listPets: {
      typescript: "pets.list",
      python: "pets.list",
      returns: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
    },
    createPet: { typescript: "pets.create", python: "pets.create" },
    getPet: { typescript: "pets.get", python: "pets.get" },
    whoAmI: { typescript: "whoAmI", python: "who_am_i" },
  },
};

// ─── The upstream API ──────────────────────────────────────────────────────────

const SECRET = "sk_live_code_mode_secret_123";
let pets: { id: string; name: string; tag?: string }[] = [];
const received: string[] = [];
let upstream: HttpServer;
let baseUrl = "";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

before(async () => {
  upstream = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      received.push(`${req.method} ${url.pathname}${url.search}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.pathname === "/pets") {
        return send(200, pets.slice(0, Number(url.searchParams.get("limit") ?? 100)));
      }
      if (req.method === "POST" && url.pathname === "/pets") {
        const pet = { id: `pet_${pets.length + 1}`, ...(JSON.parse(await readBody(req)) as { name: string }) };
        pets.push(pet);
        return send(201, pet);
      }
      const one = /^\/pets\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && one !== null) {
        const pet = pets.find((p) => p.id === one[1]);
        return pet !== undefined ? send(200, pet) : send(404, { error: "pet not found", __proto__: { admin: true } });
      }
      if (url.pathname === "/whoami") return send(200, { token: req.headers.authorization });
      return send(404, { error: "no route" });
    })();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  pets = [{ id: "pet_0", name: "Rex", tag: "dog" }];
  received.length = 0;
});

// ─── The server ────────────────────────────────────────────────────────────────

let sandbox: CodeSandbox;
before(async () => {
  const found = await nodeCodeSandbox();
  assert.ok(found !== undefined);
  sandbox = found;
});

const manifest = (extra: Partial<ToolManifest> = {}): ToolManifest => ({
  tools: [listPets, createPet, getPet, whoAmI],
  baseUrl,
  auth: "bearer",
  toolMode: "code",
  codeMode,
  ...extra,
});

const text = (result: unknown) => ((result as { content: { type: string; text: string }[] }).content[0]?.text ?? "") as string;

async function connect(
  options: Partial<CreateServerOptions> & { manifest?: ToolManifest; answer?: "accept" | "decline"; elicitation?: boolean; noSandbox?: true } = {},
) {
  const { manifest: m, answer = "accept", elicitation = true, noSandbox, ...rest } = options;
  const events: CallEvent[] = [];
  const reporter = { record: (_projectId: string, event: CallEvent) => events.push(event) } as unknown as UsageReporter;
  const server = createServer({
    source: { kind: "static", manifest: m ?? manifest(), octri: { apiUrl: "http://127.0.0.1:9", projectId: "p1", docs: false } },
    env: { prefix: "OCTRI", vars: { OCTRI_API_TOKEN: SECRET } },
    status: false,
    reporter,
    ...(noSandbox === true ? {} : { codeSandbox: sandbox }),
    ...rest,
  });
  const client = new Client({ name: "code-mode-test", version: "1.0.0" }, { capabilities: elicitation ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(String((request.params as { message?: string }).message ?? ""));
      return { action: answer, content: {} };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, prompts, events };
}

const run = (client: Client, language: string, code: string) => client.callTool({ name: RUN_CODE, arguments: { language, code } });

describe("code mode: listing", () => {
  it("lists describe_sdk and run_code in place of the operations", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), [DESCRIBE_SDK, RUN_CODE]);
    const runTool = tools.find((t) => t.name === RUN_CODE)!;
    assert.deepEqual((runTool.inputSchema.properties as { language: { enum: string[] } }).language.enum, ["typescript", "python"]);
    assert.match(runTool.description ?? "", /asks the user while the script waits/);
  });

  it("falls back to search when code mode is not published", async () => {
    const { codeMode: _published, ...unpublished } = manifest();
    const { client } = await connect({ manifest: unpublished });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("search_tools"));
    assert.ok(!names.includes(RUN_CODE));
    const called = await run(client, "typescript", "return 1");
    assert.equal(called.isError, true, "run_code is not served without code mode");
  });

  it("falls back to search when this host has no sandbox", async () => {
    const { client } = await connect({ noSandbox: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("search_tools"));
    assert.ok(!names.includes(RUN_CODE));
  });

  it("offers only the published languages this host can run", async () => {
    const { client } = await connect({ manifest: manifest({ codeMode: { ...codeMode, languages: ["python"] } }) });
    const runTool = (await client.listTools()).tools.find((t) => t.name === RUN_CODE)!;
    assert.deepEqual((runTool.inputSchema.properties as { language: { enum: string[] } }).language.enum, ["python"]);
    const refused = await run(client, "typescript", "return 1");
    assert.equal(refused.isError, true);
    assert.match(text(refused), /typescript is not offered by this server\. Use python/);
  });

  it("the person running the server can pick code mode over the owner's listing", async () => {
    const { client } = await connect({ manifest: manifest({ toolMode: "all" }), toolMode: "code" });
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [DESCRIBE_SDK, RUN_CODE]);
  });
});

describe("code mode: examples in the tool descriptions", () => {
  // The examples used to name `client.pets.list` on every API, so an agent
  // copying their shape reached for a method its SDK did not have.
  const getInvoice = op("getInvoice", "GET", "/invoices/{invoiceId}");
  const listInvoices = op("listInvoices", "GET", "/invoices");
  const sendInvoice = op("sendInvoice", "POST", "/invoices/{invoiceId}/send");
  const invoices: CodeModeManifest = {
    languages: ["typescript", "python"],
    methods: {
      getInvoice: { typescript: "invoices.get", python: "invoices.get" },
      listInvoices: { typescript: "invoices.list", python: "invoices.list" },
      sendInvoice: { typescript: "invoices.send", python: "invoices.send" },
    },
  };
  const describeOf = (tools: ReturnType<typeof codeModeTools>) => ({
    describe: tools.find((t) => t.name === DESCRIBE_SDK)?.description ?? "",
    run: tools.find((t) => t.name === RUN_CODE)?.description ?? "",
  });

  it("show this API's own read call that needs no arguments, in each language", () => {
    const { describe, run } = describeOf(
      codeModeTools(["typescript", "python"], [getInvoice, listInvoices, sendInvoice], DEFAULT_SANDBOX_LIMITS, undefined, invoices),
    );
    assert.match(run, /`const result = await client\.invoices\.list\(\)`/);
    assert.match(run, /`result = client\.invoices\.list\(\)`/);
    assert.match(describe, /call paths such as "invoices\.list"/);
    assert.doesNotMatch(run + describe, /pets/);
  });

  it("mark the arguments as elided when every method needs some", () => {
    const { run } = describeOf(codeModeTools(["typescript"], [getInvoice, sendInvoice], DEFAULT_SANDBOX_LIMITS, undefined, invoices));
    assert.match(run, /`const result = await client\.invoices\.get\(\{ \.\.\. \}\)`/);
  });
});

describe("code mode: describe_sdk", () => {
  it("lists the namespaces with no arguments", async () => {
    const { client } = await connect();
    const out = text(await client.callTool({ name: DESCRIBE_SDK, arguments: {} }));
    assert.match(out, /TypeScript SDK: 4 methods/);
    assert.match(out, /pets \(3\): list, create, get/);
  });

  it("shows TypeScript signatures with argument and return types", async () => {
    const { client } = await connect();
    const out = text(await client.callTool({ name: DESCRIBE_SDK, arguments: { names: ["pets.list", "client.pets.create"] } }));
    assert.match(out, /client\.pets\.list\(args\?: \{ limit\?: number \}\): Promise<Array<\{ id\?: string; name\?: string \}>>/);
    assert.match(out, /client\.pets\.create\(args\?: \{ body\?: \{ name\?: string; tag\?: "dog" \| "cat" \} \}\): Promise<unknown>/);
    assert.match(out, /Asks the user to approve each call\./);
  });

  it("shows Python signatures, and finds methods by query", async () => {
    const { client } = await connect();
    const out = text(await client.callTool({ name: DESCRIBE_SDK, arguments: { language: "python", query: "pet" } }));
    // The generated Python SDK's keyword: snake_case of the operation's own argument.
    assert.match(out, /client\.pets\.get\(\*, pet_id: str\) -> Any/);
    assert.match(out, /client\.pets\.list\(\*, limit: int = None\) -> list\[dict\{id\?: str, name\?: str\}\]/);
  });
});

describe("code mode: run_code", () => {
  const task = {
    typescript: [
      `const made = [];`,
      `for (const name of ["Biscuit", "Mochi"]) made.push(await client.pets.create({ body: { name, tag: "cat" } }));`,
      `const all = await client.pets.list({ limit: 10 });`,
      `console.log("pets now", all.length);`,
      `return { made: made.map((p) => p.id), names: all.map((p) => p.name) };`,
    ].join("\n"),
    python: [
      "made = []",
      "for name in ['Biscuit', 'Mochi']:",
      "    made.append(client.pets.create(body={'name': name, 'tag': 'cat'}))",
      "all_pets = client.pets.list(limit=10)",
      "print('pets now', len(all_pets))",
      "return {'made': [p['id'] for p in made], 'names': [p['name'] for p in all_pets]}",
    ].join("\n"),
  };

  for (const language of ["typescript", "python"] as const) {
    it(`${language}: a multi-call task asks once per write, sends each call, and counts each`, async () => {
      const { client, prompts, events } = await connect();
      const result = await run(client, language, task[language]);
      const out = text(result);
      assert.notEqual(result.isError, true, out);
      assert.match(out, /script finished\. 3 API calls\./);
      assert.match(out, /"made": \[\s*"pet_2",\s*"pet_3"\s*\]/);
      assert.match(out, /"names": \[\s*"Rex",\s*"Biscuit",\s*"Mochi"\s*\]/);
      assert.match(out, /Printed:\npets now 3/);
      assert.match(out, /Calls:\nPOST createPet: 201\nPOST createPet: 201\nGET listPets: 200/);
      assert.equal(prompts.length, 2, "one approval prompt per write");
      assert.match(prompts[0]!, /createPet/);
      assert.deepEqual(received, ["POST /pets", "POST /pets", "GET /pets?limit=10"]);
      assert.deepEqual(
        events.map((e) => [e.tool, e.outcome]),
        [["createPet", "ok"], ["createPet", "ok"], ["listPets", "ok"], [RUN_CODE, "ok"]],
      );
      const structured = (result as { structuredContent?: { status: string; calls: unknown[] } }).structuredContent;
      assert.equal(structured?.status, "ok");
      assert.equal(structured?.calls.length, 3);
    });

    it(`${language}: a declined write raises ApprovalDeclined and sends nothing`, async () => {
      const { client } = await connect({ answer: "decline" });
      const code =
        language === "typescript"
          ? `try { await client.pets.create({ body: { name: "X" } }); } catch (e) { return [e.name, e instanceof ApprovalDeclined]; }`
          : `try:\n    client.pets.create(body={'name': 'X'})\nexcept ApprovalDeclined as e:\n    return [e.kind, isinstance(e, ApiError)]`;
      const out = text(await run(client, language, code));
      assert.match(out, language === "typescript" ? /"ApprovalDeclined",\s*true/ : /"declined",\s*true/);
      assert.match(out, /POST createPet: declined by the user/);
      assert.deepEqual(received, []);
    });

    it(`${language}: a client that cannot ask raises ApprovalRequired`, async () => {
      const { client } = await connect({ elicitation: false });
      const code =
        language === "typescript"
          ? `try { await client.pets.create({ body: { name: "X" } }); } catch (e) { return e.name; }`
          : `try:\n    client.pets.create(body={'name': 'X'})\nexcept ApprovalRequired:\n    return 'ApprovalRequired'`;
      assert.match(text(await run(client, language, code)), /"ApprovalRequired"/);
      assert.deepEqual(received, []);
    });

    it(`${language}: a failed call raises ApiError with the status and the body as data`, async () => {
      const { client } = await connect();
      const code =
        language === "typescript"
          ? `try { await client.pets.get({ petId: "nope" }); } catch (e) { return [e.status, e.body, Object.getPrototypeOf(e.body) === Object.prototype]; }`
          : `try:\n    client.pets.get(petId='nope')\nexcept ApiError as e:\n    return [e.status, e.body]`;
      const out = text(await run(client, language, code));
      assert.match(out, /404/);
      assert.match(out, /"error": "pet not found"/);
      assert.doesNotMatch(out, /admin/, "a __proto__ key in the answer is dropped");
    });

    it(`${language}: the credential never reaches the script or the result`, async () => {
      const { client } = await connect();
      const code = language === "typescript" ? `const me = await client.whoAmI(); console.log(me.token); return me;` : `me = client.who_am_i()\nprint(me['token'])\nreturn me`;
      const out = text(await run(client, language, code));
      assert.ok(!out.includes(SECRET), out);
      assert.match(out, /Bearer \[redacted\]/);
    });
  }

  it("read-only mode leaves writes out of the SDK", async () => {
    const { client } = await connect({ permissions: { ...noUserLimits(), readOnly: true } });
    const out = text(await run(client, "typescript", `return await client.pets.create({ body: { name: "X" } });`));
    assert.match(out, /client\.pets\.create does not exist/);
    assert.deepEqual(received, []);
  });

  it("refuses an operation the SDK does not offer, even called directly", async () => {
    const { client } = await connect({ permissions: { ...noUserLimits(), deny: new Set(["whoAmI"]) } });
    const out = text(await run(client, "typescript", `return JSON.parse(await __octri_call("whoAmI", "{}"));`));
    assert.match(out, /whoAmI is not one of this server's SDK methods/);
    assert.deepEqual(received, []);
  });

  it("stops a script at the call limit", async () => {
    const { client } = await connect();
    const out = text(await run(client, "typescript", `let n = 0; try { for (;;) { await client.pets.list({}); n++; } } catch (e) { return [n, e.name]; }`));
    assert.match(out, /50,\s*"CallLimitReached"/);
    assert.equal(received.length, 50);
  });

  it("reports a failing script with what it printed and the calls it made", async () => {
    const { client } = await connect();
    const result = await run(client, "python", `print("before")\nclient.pets.list()\nraise ValueError("oops")`);
    assert.equal(result.isError, true);
    const out = text(result);
    assert.match(out, /Python script failed\. 1 API call was made before it stopped\./);
    assert.match(out, /ValueError: oops/);
    assert.match(out, /File "<script>", line 3/);
    assert.match(out, /Printed:\nbefore/);
    assert.match(out, /GET listPets: 200/);
  });

  it("asks for the code, and refuses one too long", async () => {
    const { client } = await connect();
    assert.equal((await client.callTool({ name: RUN_CODE, arguments: {} })).isError, true);
    const long = await run(client, "typescript", `// ${"x".repeat(25_000)}`);
    assert.match(text(long), /over 20000 characters/);
  });
});

describe("code mode: practice", () => {
  const practice: PracticeData = {
    "slug-listPets": { status: 200, example: [{ id: "pet_seed000001", name: "Seed" }] },
    "slug-createPet": { status: 201, schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
  };
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = (() => {
      throw new Error("practice reached the network");
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  for (const language of ["typescript", "python"] as const) {
    it(`${language}: scripts get fake answers, ask nothing, and every call counts as practice`, async () => {
      const { client, prompts, events } = await connect({ manifest: manifest({ practice }), practice: true });
      const code =
        language === "typescript"
          ? `const made = await client.pets.create({ body: { name: "Biscuit" } }); const all = await client.pets.list({}); return [made.name, all.length];`
          : `made = client.pets.create(body={'name': 'Biscuit'})\nall_pets = client.pets.list()\nreturn [made['name'], len(all_pets)]`;
      const result = await run(client, language, code);
      const out = text(result);
      assert.notEqual(result.isError, true, out);
      assert.ok(out.startsWith(PRACTICE_HEADER), "the run is marked as practice");
      assert.match(out, /"Biscuit",\s*2/);
      assert.match(out, /In real use, this call asks the user to approve it/);
      assert.equal(prompts.length, 0);
      assert.deepEqual(events.map((e) => e.outcome), ["practice", "practice", "practice"]);
      assert.deepEqual(received, []);
    });
  }
});
