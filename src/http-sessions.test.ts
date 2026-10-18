import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import http, { type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { OperationTool } from "./index.js";

// Self-hosted Streamable HTTP keeps a session per client. An "ask first" tool
// sends its approval prompt mid-call and the answer comes back on a second
// request; when every request got a fresh server, that answer reached one that
// never asked, and the call timed out instead of running. These run the real
// entry point over HTTP with the official client.

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

describe("Streamable HTTP sessions", () => {
  const hits: string[] = [];
  const upstream = http.createServer((req, res) => {
    hits.push(`${req.method ?? ""} ${req.url ?? ""}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const metadata = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tools, baseUrl: upstreamUrl, auth: "none" }));
  });
  const tools = [tool("listPets", "GET", "auto"), tool("deletePet", "DELETE", "confirm")];
  let upstreamUrl = "";
  let endpoint = "";
  let child: ChildProcess | undefined;

  before(async () => {
    upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;
    const apiPort = await listen(metadata);
    const reservation = http.createServer();
    const port = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !/^(OCTRI_|MCP_|PORT$)/.test(entry[0]),
      ),
    );
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
      env: {
        ...env,
        OCTRI_PROJECT_ID: "fixture",
        OCTRI_API_URL: `http://127.0.0.1:${apiPort}`,
        OCTRI_TELEMETRY: "0",
        MCP_TRANSPORT: "http",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    for (let attempt = 0; attempt < 100 && !stderr.includes("listening"); attempt += 1) {
      if (child.exitCode !== null) throw new Error(stderr);
      await delay(50);
    }
    assert.match(stderr, /listening/);
    endpoint = `http://127.0.0.1:${port}/mcp`;
  });

  after(async () => {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), delay(2000)]);
    }
    upstream.close();
    metadata.close();
  });

  async function connect(approval?: "accept" | "decline") {
    const client = new Client(
      { name: "http-sessions", version: "1" },
      { capabilities: approval === undefined ? {} : { elicitation: {} } },
    );
    const prompts: string[] = [];
    if (approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        prompts.push(request.params.message);
        return { action: approval, content: {} };
      });
    }
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    // SDK transport types predate exactOptionalPropertyTypes; wire contract is unchanged.
    await client.connect(transport as Transport);
    return { client, transport, prompts };
  }

  it("runs an ask-first tool once the user approves over HTTP", async () => {
    const { client, prompts } = await connect("accept");
    const result = await client.callTool({ name: "deletePet", arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.match(prompts[0] ?? "", /DELETE http:\/\/127\.0\.0\.1:\d+\/deletePet/);
    assert.equal(hits.at(-1), "DELETE /deletePet");
    await client.close();
  });

  it("holds an ask-first tool the user declines over HTTP", async () => {
    const before = hits.length;
    const { client } = await connect("decline");
    const result = await client.callTool({ name: "deletePet", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /declined/);
    assert.equal(hits.length, before);
    await client.close();
  });

  it("routes a session's requests to its server, and forgets it once ended", async () => {
    const { client, transport } = await connect();
    const id = transport.sessionId;
    assert.ok(id !== undefined && id !== "");
    assert.notEqual((await client.callTool({ name: "listPets", arguments: {} })).isError, true);
    await transport.terminateSession();
    await client.close();

    const ended = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(ended.status, 404);
  });

  it("asks for an initialize before anything else", async () => {
    const stream = await fetch(endpoint, { method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(stream.status, 400);
    const unknown = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(unknown.status, 404);
  });
});
