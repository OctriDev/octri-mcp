import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { TransportConfig } from "./config.js";

// ─── SSE transport (remote hosting) ───────────────────────────────────────────

const MAX_SSE_SESSIONS = 64;

/** Drops a trailing `:port`, unwrapping a bracketed IPv6 literal on the way. */
function bareHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  // One colon is host:port. More than one is a bare IPv6 address.
  const parts = trimmed.split(":");
  return parts.length === 2 ? (parts[0] ?? "") : trimmed;
}

function isLoopback(host: string): boolean {
  const bare = bareHost(host);
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/**
 * Guards both HTTP transports against a browser on the same machine. This server
 * holds API credentials, and any page the user visits can reach a loopback port.
 * An unlisted `Origin` marks a browser request and is refused; a non-loopback
 * `Host` catches DNS rebinding, which otherwise arrives looking local.
 *
 * Returns an error string when the request must be refused.
 */
export function httpRequestRefusal(
  headers: http.IncomingHttpHeaders,
  config: Pick<TransportConfig, "host" | "allowedOrigins"> & Partial<Pick<TransportConfig, "authToken">>,
): string | null {
  const origin = headers.origin;
  if (typeof origin === "string" && origin !== "") {
    if (!config.allowedOrigins.has(origin)) {
      return `Origin ${origin} is not allowed. Set MCP_ALLOWED_ORIGINS to permit it.`;
    }
  }

  // Every request answers with this server's API credentials, so once it is
  // reachable from the network the caller has to prove who it is.
  const token = config.authToken ?? "";
  if (token !== "" && !sameSecret(headers.authorization ?? "", `Bearer ${token}`)) {
    return "A valid Authorization: Bearer token is required.";
  }

  // Only meaningful while bound to loopback. A widened MCP_HOST means the
  // operator is fronting this themselves.
  if (isLoopback(config.host)) {
    const host = headers.host ?? "";
    if (!isLoopback(host)) {
      return `Host ${host === "" ? "(missing)" : host} is not the loopback interface.`;
    }
  }

  return null;
}

/** Constant-time comparison, so response timing says nothing about the token. */
function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Refuses to serve HTTP on a non-loopback interface without MCP_AUTH_TOKEN.
 * Bound wider, anyone who can reach the port used the operator's API
 * credentials, and the README's "behind a proxy you control" was the only
 * thing in the way.
 */
export function httpStartupRefusal(config: Pick<TransportConfig, "host" | "authToken">): string | null {
  if (isLoopback(config.host) || config.authToken !== "") return null;
  return `MCP_HOST=${config.host} is not the loopback interface. Set MCP_AUTH_TOKEN so only callers with the token can use this server.`;
}

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
      res.writeHead(403, { "Content-Type": "application/json" });
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

/**
 * Serves MCP over Streamable HTTP on a single `/mcp` endpoint.
 *
 * This is the transport the spec has defined for remote servers since revision
 * 2025-03-26; the HTTP+SSE pair below it is the 2024-11-05 design it replaced
 * and is kept only so existing deployments keep working. New hosting should use
 * this one, which is what a current client tries first.
 *
 * Stateless: every request gets its own server and transport, so nothing is
 * pinned to a session id and any number of replicas can sit behind a load
 * balancer without sharing state.
 */
export async function startStreamableHttp(
  config: TransportConfig,
  makeServer: ServerFactory,
  label: string = DEFAULT_LABEL,
): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    const refusal = httpRequestRefusal(req.headers, config);
    if (refusal !== null) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Forbidden: ${refusal}` }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Stateless mode answers a whole request/response cycle per POST. A GET or
    // DELETE only means anything for a session this mode never opens.
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed. This endpoint is stateless; use POST." }));
      return;
    }

    void (async (): Promise<void> => {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({});
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        // The SDK declares this transport's `onclose` as `(() => void) | undefined`
        // while the Transport interface it implements declares `onclose?: () => void`.
        // Those describe the same thing, but `exactOptionalPropertyTypes` treats
        // them as incompatible: an inconsistency inside the SDK's own types, so
        // it is narrowed here rather than worked around in the code around it.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res);
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
      `  MCP endpoint: POST /mcp\n`,
  );
}
