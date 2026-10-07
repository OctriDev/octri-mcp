import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { HttpMapping, OperationTool } from "./index.js";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(2000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
function tool(name: string, mapping: Partial<HttpMapping>, required: string[] = []): OperationTool {
  return {
    name, slug: name, description: name, deprecated: false,
    inputSchema: { type: "object", properties: {}, required },
    http: { method: "POST", path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [], ...mapping },
  };
}

for (const mode of ["stdio", "http", "sse"] as const) {
  test(`official Client ${mode}: wire bodies, headers, cookies, auth, refusals, semantic errors`, { timeout: 60_000 }, async () => {
    const captures: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      captures.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.setHeader("content-type", "application/json");
      res.end(req.url?.startsWith("/semantic") === true ? '{"ok":false,"error":"not_authed"}' : '{"accepted":true}');
    });
    const upstreamPort = await listen(upstream);
    const receiver = `http://127.0.0.1:${upstreamPort}`;
    const forms = { bodyParams: [{ name: "accountName", wireName: "account_name" }, { name: "items", wireName: "line_items" }], constants: [{ location: "body" as const, wireName: "kind", value: "fixture" }] };
    const tools = [
      tool("form", { ...forms, requestBody: { contentType: "application/x-www-form-urlencoded" } }),
      tool("stripeCustomer", {
        path: "/v1/customers",
        bodyParams: [
          { name: "businessName", wireName: "business_name" },
          { name: "cashBalance", wireName: "cash_balance" },
          { name: "invoiceSettings", wireName: "invoice_settings" },
          { name: "preferredLocales", wireName: "preferred_locales" },
          { name: "taxIdData", wireName: "tax_id_data" },
        ],
        requestBody: {
          contentType: "application/x-www-form-urlencoded",
          encoding: {
            business_name: { style: "deepObject", explode: true },
            cash_balance: { style: "deepObject", explode: true },
            invoice_settings: { style: "deepObject", explode: true },
            preferred_locales: { style: "deepObject", explode: true },
            tax_id_data: { style: "deepObject", explode: true },
          },
        },
      }),
      tool("multipart", { bodyParams: [{ name: "file", wireName: "file" }], requestBody: { contentType: "multipart/form-data", schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } }),
      tool("multipartNested", { requestBody: { contentType: "multipart/form-data", schema: { type: "object", properties: { "files[]": { type: "array", items: { type: "string", format: "binary" } }, nested: { type: "object", properties: { file: { type: "string", format: "binary" } } }, metadata: { type: "object" } } } } }),
      tool("patch", { method: "PATCH", requestBody: { contentType: "application/json-patch+json", schema: { type: "array" } } }),
      tool("encoded", { requestBody: { contentType: "multipart/form-data", schema: { type: "object", properties: { file: { type: "string", contentEncoding: "base64" } } } } }),
      tool("text", { requestBody: { contentType: "text/plain", schema: { type: "string" } } }),
      tool("binary", { requestBody: { contentType: "application/octet-stream", schema: { type: "string", format: "binary" } } }),
      tool("headers", { method: "GET", headerParams: [{ name: "beta", wireName: "OpenAI-Beta" }, { name: "accept", wireName: "Accept" }, { name: "spoof", wireName: "authorization" }], cookieParams: [{ name: "session", wireName: "session_id" }, { name: "cookieObject", wireName: "ignored" }], queryParams: [{ name: "tags", wireName: "tags" }, { name: "pipe", wireName: "ids", style: "pipeDelimited" }], constants: [{ location: "header", wireName: "Idempotency-Key", value: "fixed" }, { location: "cookie", wireName: "tenant", value: "fixture" }] }, ["beta"]),
      tool("optional", { requestBody: { contentType: "application/json", required: false, schema: { type: "object", required: ["name"] } } }),
      tool("semantic", { method: "GET" }),
    ];
    const metadata = http.createServer((req, res) => {
      const slack = req.url?.includes("slack-fixture") === true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ tools, baseUrl: slack ? "https://slack.com" : receiver, auth: "bearer" }));
    });
    const apiPort = await listen(metadata);
    const directory = await mkdtemp(join(tmpdir(), "octri-mcp-transport-"));
    const preload = join(directory, "receiver.mjs");
    // The actual fetch code still runs; only Slack's socket destination changes.
    // This makes the documented provider envelope test local and deterministic.
    await writeFile(preload, `const realFetch=globalThis.fetch; globalThis.fetch=(input,options)=>{const url=new URL(String(input)); return realFetch(url.hostname==='slack.com' ? ${JSON.stringify(receiver)}+url.pathname+url.search : input,options)};`);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(OCTRI_|MCP_|PORT$)/.test(entry[0])));
    Object.assign(env, { OCTRI_PROJECT_ID: "fixture", OCTRI_API_URL: `http://127.0.0.1:${apiPort}`, OCTRI_API_TOKEN: "receiver-token", MCP_TRANSPORT: mode });
    const entry = new URL("./index.js", import.meta.url).pathname;
    let child: ChildProcess | undefined;
    let stdoutBytes = 0;
    let stderr = "";
    const c = new Client({ name: "transport-regression", version: "1" }, { capabilities: {} });
    try {
      if (mode === "stdio") {
        const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, entry], env, stderr: "pipe" });
        transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        await c.connect(transport);
      } else {
        const reservation = http.createServer();
        const port = await listen(reservation);
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        child = spawn(process.execPath, ["--import", preload, entry], { env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        for (let attempt = 0; attempt < 100 && !stderr.includes("listening"); attempt += 1) {
          if (child.exitCode !== null) throw new Error(stderr);
          await delay(50);
        }
        assert.match(stderr, /listening/);
        // SDK transport types predate exactOptionalPropertyTypes; wire contract is unchanged.
        const transport = mode === "http" ? new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) : new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`));
        await c.connect(transport as Transport);
      }
      assert.equal((await c.listTools()).tools.length, tools.length + 7);
      const call = async (name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
      const last = () => { const capture = captures.at(-1); assert.ok(capture); return capture; };
      assert.notEqual((await call("form", { body: { accountName: "nested", items: [{ price_id: "p1", quantity: 2 }, { price_id: "p2", quantity: 3 }] } })).isError, true);
      assert.equal(last().headers["content-type"], "application/x-www-form-urlencoded");
      const form = new URLSearchParams(last().body.toString());
      assert.equal(form.get("account_name"), "nested"); assert.equal(form.get("kind"), "fixture");
      assert.equal(form.get("line_items[0][price_id]"), "p1"); assert.equal(form.get("line_items[1][quantity]"), "3");
      assert.notEqual((await call("stripeCustomer", {
        body: {
          businessName: "Octri", cashBalance: { settings: { reconciliation_mode: "manual" } },
          invoiceSettings: { custom_fields: [{ name: "PO", value: "42" }] },
          preferredLocales: ["en", "fr"], taxIdData: [{ type: "eu_vat", value: "EU123" }],
        },
      })).isError, true);
      assert.equal(last().path, "/v1/customers");
      assert.equal(last().headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(last().headers.authorization, "Bearer receiver-token");
      const stripeForm = new URLSearchParams(last().body.toString());
      assert.equal(stripeForm.get("business_name"), "Octri");
      assert.equal(stripeForm.get("cash_balance[settings][reconciliation_mode]"), "manual");
      assert.equal(stripeForm.get("invoice_settings[custom_fields][0][name]"), "PO");
      assert.equal(stripeForm.get("invoice_settings[custom_fields][0][value]"), "42");
      assert.deepEqual(stripeForm.getAll("preferred_locales[]"), ["en", "fr"]);
      assert.equal(stripeForm.get("tax_id_data[0][type]"), "eu_vat");
      assert.equal(stripeForm.get("tax_id_data[0][value]"), "EU123");
      assert.notEqual((await call("multipart", { body: { file: { filename: "input.wav", content: "UklGRg==", contentType: "audio/wav" } } })).isError, true);
      assert.match(last().headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      assert.ok(last().body.includes(Buffer.from("RIFF"))); assert.match(last().body.toString(), /filename="input.wav"/);
      assert.notEqual((await call("multipartNested", { body: { "files[]": [{ filename: "one.txt", content: "b25l" }, { filename: "two.txt", content: "dHdv" }], nested: { file: { filename: "nested.txt", content: "bmVzdGVk" } }, metadata: { filename: "data", content: "ordinary text" } } })).isError, true);
      const nestedWire = last().body.toString();
      assert.equal(nestedWire.match(/name="files\[\]"/g)?.length, 2);
      assert.match(nestedWire, /name="nested\[file\]"; filename="nested.txt"/);
      assert.match(nestedWire, /Content-Type: application\/json/i);
      assert.ok(nestedWire.includes('{"filename":"data","content":"ordinary text"}'));
      const patch = [{ op: "replace", path: "/account_name", value: "fixture" }];
      assert.notEqual((await call("encoded", { body: { file: "UklGRg==" } })).isError, true);
      assert.match(last().body.toString(), /name="file"\r\n\r\nUklGRg==/);
      assert.notEqual((await call("patch", { body: patch })).isError, true); assert.deepEqual(JSON.parse(last().body.toString()), patch);
      assert.equal(last().headers["content-type"], "application/json-patch+json");
      assert.notEqual((await call("text", { body: "raw text" })).isError, true); assert.equal(last().body.toString(), "raw text");
      assert.notEqual((await call("binary", { body: { filename: "payload.bin", content: "AAEC/w==" } })).isError, true); assert.deepEqual(last().body, Buffer.from([0, 1, 2, 255]));
      let before = captures.length;
      assert.equal((await call("headers", {})).isError, true); assert.equal(captures.length, before);
      assert.notEqual((await call("headers", { beta: "agents=v1", accept: "text/event-stream", spoof: "Bearer wrong", session: "safe;value", cookieObject: { region: "eu", mode: "live" }, tags: ["one", "two"], pipe: ["a", "b"] })).isError, true);
      assert.equal(last().headers["openai-beta"], "agents=v1"); assert.equal(last().headers.authorization, "Bearer receiver-token");
      assert.equal(last().headers.accept, "text/event-stream");
      assert.equal(last().headers["idempotency-key"], "fixed"); assert.match(last().headers.cookie ?? "", /session_id=safe%3Bvalue/);
      assert.match(last().headers.cookie ?? "", /region=eu/); assert.match(last().headers.cookie ?? "", /mode=live/);
      assert.match(last().headers.cookie ?? "", /tenant=fixture/);
      assert.deepEqual(new URL(last().path, receiver).searchParams.getAll("tags"), ["one", "two"]);
      assert.equal(new URL(last().path, receiver).searchParams.get("ids"), "a|b");
      assert.notEqual((await call("optional")).isError, true); assert.equal(last().body.length, 0); assert.equal(last().headers["content-type"], undefined);
      assert.notEqual((await call("semantic")).isError, true, "Arbitrary ok:false response is valid data");
      assert.equal((await call("semantic", { projectId: "slack-fixture" })).isError, true, "Slack documented envelope is an error");
      before = captures.length;
      for (const file of ["/etc/passwd", "https://example.invalid/file", { filename: "../secret", content: "AA==" }, { filename: "big", content: "A".repeat(14_000_000) }]) {
        // Stdio and legacy SSE impose their own bounded JSON-RPC message limit
        // before the server sees a 14 MB descriptor. That rejection is desired;
        // prove no upstream request was made and keep the process test alive.
        if (typeof file === "object" && file.content.length > 1_000_000 && mode !== "http") {
          await assert.rejects(call("binary", { body: file }));
          assert.equal(captures.length, before);
          break;
        }
        assert.equal((await call("binary", { body: file })).isError, true); assert.equal(captures.length, before);
      }
      assert.equal(stdoutBytes, 0, "HTTP/SSE stdout must remain protocol-free");
    } finally {
      await c.close(); await stop(child);
      await Promise.all([new Promise<void>((resolve) => metadata.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
