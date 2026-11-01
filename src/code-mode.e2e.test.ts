import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { McpToolsResponse, OperationTool } from "./operations.js";

// Code mode end to end: the official MCP SDK client talks over stdio to the
// real `octri-mcp` process (and to the MCP Bundle's single-file server), which
// reads its tools from a fake Octri API and runs each script on a worker
// thread. The script's calls reach a fake upstream on loopback. Nothing is
// mocked inside the server.

const SECRET = "sk_e2e_secret_value_456";

function op(name: string, method: string, path: string): OperationTool {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1] ?? "", wireName: m[1] ?? "" }));
  const write = method !== "GET";
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} description`,
    deprecated: false,
    inputSchema: {
      type: "object",
      properties: {
        ...Object.fromEntries(pathParams.map((p) => [p.name, { type: "string" }])),
        ...(write ? { body: { type: "object", properties: { status: { type: "string" } } } } : {}),
        ...(!write && pathParams.length === 0 ? { status: { type: "string" } } : {}),
      },
      required: pathParams.map((p) => p.name),
    },
    http: {
      method,
      path,
      pathParams,
      queryParams: !write && pathParams.length === 0 ? [{ name: "status", wireName: "status" }] : [],
      bodyParams: [],
      ...(write ? { requestBody: { contentType: "application/json" } } : {}),
      constants: [],
    },
    policy: write ? "confirm" : "auto",
  } as OperationTool;
}

let orders: { id: string; status: string; total: number }[] = [];
const received: string[] = [];
let http: HttpServer;
let origin = "";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** One loopback server plays both parts: the Octri API (`/api/v1/...`) and the customer's API (`/shop/...`). */
before(async () => {
  http = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/v1/public/mcp/p1/tools") {
        const manifest: McpToolsResponse = {
          tools: [op("listOrders", "GET", "/orders"), op("getOrder", "GET", "/orders/{orderId}"), op("updateOrder", "PATCH", "/orders/{orderId}")],
          baseUrl: `${origin}/shop`,
          auth: "bearer",
          toolMode: "code",
          codeMode: {
            languages: ["typescript", "python"],
            methods: {
              listOrders: { typescript: "orders.list", python: "orders.list" },
              getOrder: { typescript: "orders.retrieve", python: "orders.retrieve" },
              updateOrder: { typescript: "orders.update", python: "orders.update" },
            },
          },
        };
        return send(200, manifest);
      }
      if (url.pathname.startsWith("/api/v1/")) return send(404, { error: "not here" });
      received.push(`${req.method} ${url.pathname}${url.search} ${req.headers.authorization === `Bearer ${SECRET}` ? "auth" : "no-auth"}`);
      if (req.method === "GET" && url.pathname === "/shop/orders") {
        const status = url.searchParams.get("status");
        return send(200, orders.filter((o) => status === null || o.status === status).map((o) => ({ id: o.id })));
      }
      const one = /^\/shop\/orders\/([^/]+)$/.exec(url.pathname);
      const order = orders.find((o) => o.id === one?.[1]);
      if (order === undefined) return send(404, { error: "order not found" });
      if (req.method === "GET") return send(200, order);
      if (req.method === "PATCH") {
        Object.assign(order, (JSON.parse(await readBody(req)) as { status: string }));
        return send(200, order);
      }
      return send(405, { error: "method" });
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

const scripts = {
  // Flag every pending order over 100: a list, a read per order, a write per match.
  typescript: [
    `const pending = await client.orders.list({ status: "pending" });`,
    `const flagged: string[] = [];`,
    `for (const { id } of pending) {`,
    `  const order = await client.orders.retrieve({ orderId: id });`,
    `  if (order.total > 100) { await client.orders.update({ orderId: id, body: { status: "review" } }); flagged.push(id); }`,
    `}`,
    `return { checked: pending.length, flagged };`,
  ].join("\n"),
  python: [
    "pending = client.orders.list(status='pending')",
    "flagged = []",
    "for o in pending:",
    "    order = client.orders.retrieve(order_id=o['id'])",
    "    if order['total'] > 100:",
    "        client.orders.update(order_id=o['id'], body={'status': 'review'})",
    "        flagged.append(o['id'])",
    "return {'checked': len(pending), 'flagged': flagged}",
  ].join("\n"),
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const entries = [
  ["npm package (dist/index.js)", `${packageRoot}dist/index.js`],
  ["MCP Bundle (bundle/server.js)", `${packageRoot}bundle/server.js`],
] as const;

for (const [label, entry] of entries) {
  describe(`code mode end to end: ${label}`, { skip: !existsSync(entry) && "not built" }, () => {
    for (const language of ["typescript", "python"] as const) {
      it(`${language}: one run_code call does a multi-call task, with one approval per write`, async () => {
        orders = [
          { id: "o1", status: "pending", total: 250 },
          { id: "o2", status: "pending", total: 40 },
          { id: "o3", status: "shipped", total: 900 },
          { id: "o4", status: "pending", total: 120 },
        ];
        received.length = 0;
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [entry],
          env: {
            ...(process.env as Record<string, string>),
            OCTRI_API_URL: `${origin}/api/v1`,
            OCTRI_PROJECT_ID: "p1",
            OCTRI_API_TOKEN: SECRET,
            OCTRI_TELEMETRY: "0",
            OCTRI_OUTAGE_STATUS: "0",
            OCTRI_CHANGE_NOTICES: "0",
          },
          stderr: "pipe",
        });
        const client = new Client({ name: "code-mode-e2e", version: "1.0.0" }, { capabilities: { elicitation: {} } });
        let prompts = 0;
        client.setRequestHandler(ElicitRequestSchema, async () => {
          prompts++;
          return { action: "accept", content: {} };
        });
        await client.connect(transport);
        try {
          const names = (await client.listTools()).tools.map((t) => t.name);
          assert.ok(names.includes("run_code") && names.includes("describe_sdk"), names.join(", "));
          assert.ok(!names.includes("listOrders"), "operations are behind the SDK, not listed");

          const result = await client.callTool({ name: "run_code", arguments: { language, code: scripts[language] } });
          const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
          assert.notEqual(result.isError, true, text);
          assert.match(text, /"checked": 3/);
          assert.match(text, /"flagged": \[\s*"o1",\s*"o4"\s*\]/);
          assert.equal(prompts, 2, "one approval prompt per write");
          assert.deepEqual(received, [
            "GET /shop/orders?status=pending auth",
            "GET /shop/orders/o1 auth",
            "PATCH /shop/orders/o1 auth",
            "GET /shop/orders/o2 auth",
            "GET /shop/orders/o4 auth",
            "PATCH /shop/orders/o4 auth",
          ]);
          assert.deepEqual(orders.map((o) => o.status), ["review", "pending", "shipped", "review"]);
        } finally {
          await client.close();
        }
      });
    }
  });
}
