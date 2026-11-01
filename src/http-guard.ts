import type { TransportConfig } from "./config.js";

// ─── HTTP request guard ─────────────────────────────────────────────────────────
//
// Shared by the Node transports and the Cloudflare Worker, so it imports
// nothing from Node: headers arrive as a plain lowercase-keyed map.

/** Request headers, lowercase keys, as Node's `IncomingHttpHeaders` holds them. */
export type RequestHeaders = Record<string, string | string[] | undefined>;

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

export function isLoopback(host: string): boolean {
  const bare = bareHost(host);
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

function header(headers: RequestHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

/**
 * Guards every HTTP transport against a browser on the same machine. This server
 * holds API credentials, and any page the user visits can reach a loopback port.
 * An unlisted `Origin` marks a browser request and is refused; a non-loopback
 * `Host` catches DNS rebinding, which otherwise arrives looking local.
 *
 * Returns an error string when the request must be refused.
 */
/** The refusal for a missing or wrong MCP_AUTH_TOKEN. */
const TOKEN_REFUSAL = "A valid Authorization: Bearer token is required.";

/**
 * The status and headers a refusal goes out with: 401 and a Bearer challenge
 * when the token is missing or wrong (RFC 6750), 403 for an origin or host
 * this server will not answer whoever asks. The Node transports and the
 * Worker answer alike.
 */
export function refusalResponse(refusal: string): { status: 401 | 403; headers: Record<string, string> } {
  return refusal === TOKEN_REFUSAL
    ? { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }
    : { status: 403, headers: { "Content-Type": "application/json" } };
}

export function httpRequestRefusal(
  headers: RequestHeaders,
  config: Pick<TransportConfig, "host" | "allowedOrigins"> & Partial<Pick<TransportConfig, "authToken">>,
): string | null {
  const origin = header(headers, "origin");
  if (origin !== "" && !config.allowedOrigins.has(origin)) {
    return `Origin ${origin} is not allowed. Set MCP_ALLOWED_ORIGINS to permit it.`;
  }

  // Every request answers with this server's API credentials, so once it is
  // reachable from the network the caller has to prove who it is.
  const token = config.authToken ?? "";
  if (token !== "" && !sameSecret(header(headers, "authorization"), `Bearer ${token}`)) {
    return TOKEN_REFUSAL;
  }

  // Only meaningful while bound to loopback. A widened MCP_HOST means the
  // operator is fronting this themselves.
  if (isLoopback(config.host)) {
    const host = header(headers, "host");
    if (!isLoopback(host)) {
      return `Host ${host === "" ? "(missing)" : host} is not the loopback interface.`;
    }
  }

  return null;
}

/**
 * Constant-time comparison, so response timing says nothing about the token.
 * Written out rather than `crypto.timingSafeEqual`, which a Worker lacks.
 */
export function sameSecret(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
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

/** What `GET /health` answers: enough for a container or load balancer probe, nothing about the API. */
export const HEALTH_BODY = JSON.stringify({ status: "ok" });
