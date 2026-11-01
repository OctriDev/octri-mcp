import { randomUUID } from "node:crypto";
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { HEALTH_BODY, httpRequestRefusal, refusalResponse } from "./http-guard.js";
import { HTTP_SESSION_IDLE_MS, MAX_HTTP_SESSIONS } from "./session-limits.js";
import type { TransportConfig } from "./config.js";

export { httpRequestRefusal, httpStartupRefusal } from "./http-guard.js";
export { HTTP_SESSION_IDLE_MS, MAX_HTTP_SESSIONS } from "./session-limits.js";

// ─── SSE transport (remote hosting) ───────────────────────────────────────────

const MAX_SSE_SESSIONS = 64;

/** A fresh server per session (SSE) or per request (Streamable HTTP). */
export type ServerFactory = () => Server;

/** How the startup lines name the server: "Octri MCP server" unless a build says otherwise. */
const DEFAULT_LABEL = "Octri MCP server";

export async function startSse(
  config: TransportConfig,
  makeServer: ServerFactory,
  label: string = DEFAULT_LABEL,
): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${config.port}`,
    );

    const refusal = httpRequestRefusal(req.headers, config);
    if (refusal !== null) {
      const { status, headers } = refusalResponse(refusal);
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: `Forbidden: ${refusal}` }));
      return;
    }

    // GET /sse: open a new SSE connection
    if (req.method === "GET" && url.pathname === "/sse") {
      if (sessions.size >= MAX_SSE_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many open sessions" }));
        return;
      }
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);

      const server = makeServer();
      server.connect(transport).catch((err: unknown) => {
        process.stderr.write(`SSE connect error: ${String(err)}\n`);
      });

      transport.onclose = () => {
        sessions.delete(transport.sessionId);
      };
      return;
    }

    // POST /messages?sessionId=X: forward client message to the right session
    if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = sessions.get(sessionId);

      if (transport === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      transport.handlePostMessage(req, res).catch((err: unknown) => {
        process.stderr.write(`Message handler error: ${String(err)}\n`);
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });

  process.stderr.write(
    `${label} (SSE) listening on http://${config.host}:${config.port}\n`,
  );
  process.stderr.write(
    `  SSE endpoint:  GET  /sse\n  Message relay: POST /messages?sessionId=<id>\n`,
  );
}

// ─── Stdio transport (local / Claude Desktop / Cursor) ────────────────────────

export async function startStdio(makeServer: ServerFactory): Promise<void> {
  const server = makeServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Streamable HTTP transport (current spec, for remote hosting) ─────────────

interface HttpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

/** A JSON-RPC error, the shape an MCP client reads off a refused request. */
function rpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Serves MCP over Streamable HTTP on a single `/mcp` endpoint.
 *
 * This is the transport the spec has defined for remote servers since revision
 * 2025-03-26; the HTTP+SSE pair below it is the 2024-11-05 design it replaced
 * and is kept only so existing deployments keep working. New hosting should use
 * this one, which is what a current client tries first.
 *
 * Stateful: a client's initialize opens a session (its id comes back in the
 * `mcp-session-id` header), and every later request carrying that id reaches
 * the same server. It has to: an "ask first" tool sends the client an approval
 * prompt in the middle of a call, and the answer arrives on a second request.
 * Stateless, that request reached a fresh server that never asked, and the call
 * sat out its approval timeout before being refused. Behind several replicas,
 * route by `mcp-session-id` (sticky sessions).
 */
export async function startStreamableHttp(
  config: TransportConfig,
  makeServer: ServerFactory,
  label: string = DEFAULT_LABEL,
): Promise<void> {
  const sessions = new Map<string, HttpSession>();

  const closeSession = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (session === undefined) return;
    // Out of the map first: closing the transport calls back into onclose.
    sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };

  const sweep = async (now: number = Date.now()): Promise<void> => {
    const idle = [...sessions.entries()]
      .filter(([, session]) => now - session.lastSeen > HTTP_SESSION_IDLE_MS)
      .map(([id]) => id);
    await Promise.all(idle.map(closeSession));
  };
  // A pending sweep must never keep a stopped server alive.
  setInterval(() => void sweep(), 60_000).unref();

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    // A container or load balancer probe carries no token, so the health check
    // skips it. The origin and host checks still apply, and the answer says
    // nothing about the API.
    const health = req.method === "GET" && url.pathname === "/health";
    const refusal = httpRequestRefusal(req.headers, health ? { ...config, authToken: "" } : config);
    if (refusal !== null) {
      const { status, headers } = refusalResponse(refusal);
      res.writeHead(status, headers);
      res.end(JSON.stringify({ error: `Forbidden: ${refusal}` }));
      return;
    }
    if (health) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(HEALTH_BODY);
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    void (async (): Promise<void> => {
      try {
        const header = req.headers["mcp-session-id"];
        if (typeof header === "string" && header !== "") {
          const session = sessions.get(header);
          // 404 is the spec's signal to start a new session, which clients do.
          if (session === undefined) {
            rpcError(res, 404, "Session not found or expired. Start a new one.");
            return;
          }
          session.lastSeen = Date.now();
          // GET opens the session's event stream, DELETE ends the session,
          // POST carries a message: the transport tells them apart.
          await session.transport.handleRequest(req, res);
          return;
        }

        if (req.method !== "POST") {
          rpcError(res, 400, "No session. Send an initialize request first.");
          return;
        }
        if (sessions.size >= MAX_HTTP_SESSIONS) await sweep();
        if (sessions.size >= MAX_HTTP_SESSIONS) {
          rpcError(res, 503, "Too many open sessions. Try again shortly.");
          return;
        }

        const server = makeServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId !== undefined) void closeSession(transport.sessionId);
        };
        // The SDK declares this transport's `onclose` as `(() => void) | undefined`
        // while the Transport interface it implements declares `onclose?: () => void`.
        // Those describe the same thing, but `exactOptionalPropertyTypes` treats
        // them as incompatible: an inconsistency inside the SDK's own types, so
        // it is narrowed here rather than worked around in the code around it.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res);
        // Not an initialize request: the transport refused it, no session was
        // opened, and nothing will ever reach this server again.
        if (transport.sessionId === undefined) await server.close();
      } catch (err: unknown) {
        process.stderr.write(`Streamable HTTP error: ${String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, resolve);
  });

  process.stderr.write(
    `${label} (Streamable HTTP) listening on http://${config.host}:${config.port}\n` +
      `  MCP endpoint: POST /mcp (sessions: route by the mcp-session-id header)\n` +
      `  Health check: GET  /health\n`,
  );
}
