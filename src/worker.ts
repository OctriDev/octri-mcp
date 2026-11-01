import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { loadConfig } from "./config.js";
import { envList, type EnvSource } from "./env.js";
import { HEALTH_BODY, httpRequestRefusal, refusalResponse, type RequestHeaders } from "./http-guard.js";
import { logLine } from "./log.js";
import { inProcessCodeSandbox, type SandboxWasm } from "./code-sandbox-wasm.js";
import { WORKER_SANDBOX_LIMITS } from "./code-sandbox.js";
import { createServer, type OctriProject, type ServerBranding, type ToolManifest } from "./server.js";
import { HTTP_SESSION_IDLE_MS } from "./session-limits.js";
import { UsageReporter } from "./usage.js";

// ─── Cloudflare Worker host ────────────────────────────────────────────────────
//
// Serves a static manifest over Streamable HTTP from a Cloudflare Worker, for a
// team that hosts its API's MCP server on its own Cloudflare account.
//
// Sessions are Durable Objects. A client's initialize goes to a new object, the
// object's id comes back as the `mcp-session-id`, and every later request with
// that id reaches the same object, which keeps the session's server in memory.
// That is what lets an "ask first" tool work: its approval prompt goes out in
// the middle of a call, the answer arrives on a second request, and both reach
// the one server that asked. A Durable Object with a request in flight is kept
// running, and waiting costs no CPU time, so the approval timeout holds.
//
// What this host does not do: the legacy HTTP+SSE transport (Streamable HTTP
// only), or keep a session across a restart of its object (a redeploy, or
// Cloudflare moving it). The client then gets a 404, which the spec defines as
// "start a new session", and any approval still waiting is lost.
//
// Workers also forbid compiling code at runtime, so the server checks approval
// answers with the MCP SDK's Workers validator (`@cfworker/json-schema`,
// bundled into the Worker core) rather than its default, Ajv.
//
// Cloudflare's own `McpAgent` is deprecated, and its `createMcpHandler` is
// stateless, which cannot push an approval prompt mid-call. This host needs
// neither: the MCP SDK's web-standard transport runs inside the object as is.
//
// Two ways to let a client in. By default every client sends the one
// MCP_AUTH_TOKEN and every call uses the API credentials in the Worker's
// secrets. In OAuth mode (the generated project's `src/oauth.js`, wrapped in
// Cloudflare's `@cloudflare/workers-oauth-provider`) each user signs in through
// this Worker: the consent page asks for their own API key, the provider keeps
// it encrypted in the grant, and their sessions call the API with it and never
// with a shared secret. The provider is the customer project's dependency, not
// this package's: the consent page below uses only the helpers it hands over
// as `env.OAUTH_PROVIDER`.
//
// No Cloudflare types are imported: the shapes below are the parts used.

/** The parts of a Durable Object id this host uses. */
export interface DurableObjectIdLike {
  toString(): string;
}

/** The parts of a Durable Object namespace binding this host uses. */
export interface DurableObjectNamespaceLike {
  newUniqueId(): DurableObjectIdLike;
  /** Throws on a string that is not an id of this namespace. */
  idFromString(id: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): { fetch(request: Request): Promise<Response> };
}

/** The parts of a Durable Object's state this host uses. */
export interface DurableObjectStateLike {
  id: DurableObjectIdLike;
  storage: {
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The Worker's bindings: the session namespace, and the variables and secrets
 * the server reads (`ACME_API_KEY`, `MCP_AUTH_TOKEN`, ...). Anything that is
 * not a string is a binding and is never read as a setting.
 */
export interface WorkerEnv {
  MCP_SESSION: DurableObjectNamespaceLike;
  [name: string]: unknown;
}

export interface WorkerServerOptions {
  manifest: ToolManifest;
  branding: ServerBranding;
  /** Prefix of every variable the server reads, e.g. `ACME`. */
  envPrefix: string;
  /** The Octri project for documentation tools and usage counts. Absent: neither. */
  octri?: OctriProject;
  /**
   * The code mode interpreters, imported as wasm modules by the Worker's entry
   * (a Worker cannot compile wasm from bytes at runtime). Absent: no code mode,
   * and a request for it lists search mode instead.
   */
  codeSandbox?: SandboxWasm;
  /**
   * The variables holding the API's credentials (`ACME_API_KEY`). In OAuth mode
   * the consent page asks each user for these, and the Worker's own values are
   * never used.
   */
  credentialVars?: string[];
}

/** What an OAuth grant carries for this host: the props the consent page stores. */
export interface WorkerGrant {
  /** A random id per grant. A session opened under one grant serves no other. */
  owner: string;
  /** The user's own credentials, keyed by variable name. */
  credentials: Record<string, string>;
}

/** The parts of an authorization request the consent page passes back to the provider. */
export interface OAuthAuthRequestLike {
  scope: string[];
}

/** The facts the consent page must show, as the provider's `describeConsent` returns them. */
export interface OAuthConsentDescriptionLike {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
}

/** The parts of `env.OAUTH_PROVIDER` (the provider's helpers) the consent page uses. */
export interface OAuthHelpersLike {
  parseAuthRequest(request: Request): Promise<OAuthAuthRequestLike>;
  describeConsent(authRequest: OAuthAuthRequestLike): Promise<OAuthConsentDescriptionLike>;
  beginConsent(authRequest: OAuthAuthRequestLike): Promise<{ handle: string; headers: Headers }>;
  approveConsent(request: Request, handle: string): Promise<{ request: OAuthAuthRequestLike; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ headers: Headers }>;
  completeAuthorization(options: {
    request: OAuthAuthRequestLike;
    userId: string;
    metadata: unknown;
    scope: string[];
    props: WorkerGrant;
  }): Promise<{ redirectTo: string }>;
}

/** The parts of the provider's execution context the API handler reads. */
export interface OAuthContextLike {
  props?: unknown;
}

/** The request path the MCP endpoint answers on, as the Node transport. */
export const WORKER_MCP_PATH = "/mcp";

/** The OAuth consent page, which `src/oauth.js` names as the provider's `authorizeEndpoint`. */
export const WORKER_AUTHORIZE_PATH = "/authorize";

/**
 * How the OAuth API handler hands a session its grant. Set only by this host:
 * any copy a client sends is dropped before a request reaches a session.
 */
const GRANT_HEADER = "x-octri-mcp-grant";

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json", ...extra } });
}

/** A JSON-RPC error, the shape an MCP client reads off a refused request. */
function rpcError(status: number, message: string): Response {
  return json(status, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** The Worker's string variables and secrets, the only things read as settings. */
export function workerVars(env: Record<string, unknown>): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") vars[name] = value;
  }
  return vars;
}

function headerMap(request: Request): RequestHeaders {
  const headers: RequestHeaders = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

/** The request with the grant header removed, and set to `grant` when one is given. */
function withGrant(request: Request, grant: WorkerGrant | undefined): Request {
  const headers = new Headers(request.headers);
  headers.delete(GRANT_HEADER);
  if (grant !== undefined) headers.set(GRANT_HEADER, JSON.stringify(grant));
  return new Request(request, { headers });
}

/** A grant's props, or undefined when they are not the shape the consent page stores. */
export function parseGrant(value: unknown): WorkerGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { owner, credentials } = value as Record<string, unknown>;
  if (typeof owner !== "string" || owner === "" || typeof credentials !== "object" || credentials === null) {
    return undefined;
  }
  const values: Record<string, string> = {};
  for (const [name, secret] of Object.entries(credentials)) {
    if (typeof secret !== "string") return undefined;
    values[name] = secret;
  }
  return { owner, credentials: values };
}

function grantFromHeader(request: Request): WorkerGrant | undefined {
  const raw = request.headers.get(GRANT_HEADER);
  if (raw === null) return undefined;
  try {
    return parseGrant(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * The settings a session reads: the Worker's variables, and under a grant the
 * user's own credentials in place of the Worker's. Every credential variable
 * is dropped first, so a user who left one out never falls back to a secret.
 */
export function sessionVars(
  env: Record<string, unknown>,
  grant: WorkerGrant | undefined,
  credentialVars: readonly string[],
): NodeJS.ProcessEnv {
  const vars = workerVars(env);
  if (grant === undefined) return vars;
  for (const name of credentialVars) delete vars[name];
  for (const name of credentialVars) {
    const value = grant.credentials[name];
    if (value !== undefined) vars[name] = value;
  }
  return vars;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A credential's field label: `ACME_API_KEY` is "API key", `ACME_API_USERNAME` is "Username". */
export function credentialLabel(name: string, envPrefix: string): string {
  const suffix = name.startsWith(`${envPrefix}_`) ? name.slice(envPrefix.length + 1) : name;
  const labels: Record<string, string> = {
    API_KEY: "API key",
    API_TOKEN: "API token",
    API_USERNAME: "Username",
    API_PASSWORD: "Password",
  };
  return labels[suffix] ?? suffix;
}

export interface ConsentPageInput {
  serverName: string;
  details: OAuthConsentDescriptionLike;
  handle: string;
  fields: { name: string; label: string; secret: boolean }[];
  error?: string;
}

/**
 * The consent page. Every string from the client (its name, its redirect host)
 * is attacker-chosen under dynamic registration, so all of it is escaped, and
 * the page says where the access goes, the one fact a phishing client cannot
 * fake.
 */
export function consentPage(input: ConsentPageInput): string {
  const { details } = input;
  const server = escapeHtml(input.serverName);
  const client = escapeHtml(details.clientName);
  const origin =
    details.clientDomain !== undefined
      ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
      : "This app registered itself, so its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>`
    : "";
  const fields = input.fields
    .map(
      (f, i) => `<label for="f${i}">${escapeHtml(f.label)}</label>
<input id="f${i}" name="${escapeHtml(f.name)}" type="${f.secret ? "password" : "text"}" autocomplete="off" spellcheck="false" required${i === 0 ? " autofocus" : ""}>`,
    )
    .join("\n");
  const error = input.error !== undefined ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect ${client} to ${server}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f8; --card: #fff; --text: #18181b; --muted: #5f5f68; --field: #f0f0f2; --accent: #e8590c; --warn: #fff4e5; --error: #fdecec; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --card: #1b1b1e; --text: #ededf0; --muted: #a0a0aa; --field: #26262b; --warn: #3a2a12; --error: #3d1717; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { width: 100%; max-width: 440px; background: var(--card); border-radius: 8px; padding: 28px; }
h1 { font-size: 20px; margin: 0 0 12px; }
p { margin: 0 0 12px; color: var(--muted); }
strong { color: var(--text); }
.warn, .error { padding: 10px 12px; border-radius: 4px; color: var(--text); }
.warn { background: var(--warn); }
.error { background: var(--error); }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input { width: 100%; padding: 10px 12px; border: 0; border-radius: 4px; background: var(--field); color: var(--text); font: inherit; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Allow comes first in the form, so Enter approves; it still sits on the right. */
.actions { display: flex; flex-direction: row-reverse; gap: 8px; margin-top: 20px; }
button { flex: 1; padding: 10px 12px; border: 0; border-radius: 4px; font: inherit; font-weight: 600; cursor: pointer; background: var(--field); color: var(--text); }
button[value="approve"] { background: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
<h1>Connect ${client} to ${server}</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>Every call it makes through ${server} will use the credentials you enter here. They are stored encrypted, and you can sign in again at any time to replace them.</p>
${error}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
${fields}
<div class="actions">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>
</main>
</body>
</html>
`;
}

/** A session object, as the Durable Objects runtime calls it. */
export interface McpSessionObject {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

/** The env the OAuth entry's handlers receive: the Worker's, plus the provider's helpers. */
export interface WorkerOAuthEnv extends WorkerEnv {
  OAUTH_PROVIDER: OAuthHelpersLike;
}

export interface WorkerServer {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
  McpSession: new (state: DurableObjectStateLike, env: Record<string, unknown>) => McpSessionObject;
  /**
   * OAuth mode, for `src/oauth.js`: `api` is the provider's `apiHandler` for
   * `/mcp`, reached only with a valid access token, and `fetch` its
   * `defaultHandler`, which serves the consent page and the health check.
   */
  oauth: {
    api: { fetch(request: Request, env: WorkerEnv, ctx: OAuthContextLike): Promise<Response> };
    fetch(request: Request, env: WorkerOAuthEnv): Promise<Response>;
  };
}

/**
 * The Worker's `fetch` and its session class. The generated entry exports
 * both: `export const McpSession = worker.McpSession`, bound in wrangler.jsonc
 * as `MCP_SESSION`.
 */
export function createWorkerServer(options: WorkerServerOptions): WorkerServer {
  const { manifest, branding, envPrefix, octri } = options;
  const codeSandbox = options.codeSandbox !== undefined ? inProcessCodeSandbox(options.codeSandbox) : undefined;
  const credentialVars = options.credentialVars ?? [];

  function guardFor(env: Record<string, unknown>) {
    // A Worker is public the moment it is deployed: never treated as loopback.
    return { host: "0.0.0.0", allowedOrigins: envList(workerVars(env)["MCP_ALLOWED_ORIGINS"]) };
  }

  function health(request: Request, env: Record<string, unknown>): Response {
    const refusal = httpRequestRefusal(headerMap(request), guardFor(env));
    return refusal === null ? json(200, HEALTH_BODY) : json(403, JSON.stringify({ error: `Forbidden: ${refusal}` }));
  }

  /** Hands an authenticated request to its session's object, or a new one on initialize. */
  async function toSession(request: Request, env: WorkerEnv, grant: WorkerGrant | undefined): Promise<Response> {
    const namespace = env.MCP_SESSION;
    const forwarded = withGrant(request, grant);
    const sessionId = request.headers.get("mcp-session-id") ?? "";
    if (sessionId !== "") {
      let id: DurableObjectIdLike;
      try {
        id = namespace.idFromString(sessionId);
      } catch {
        return rpcError(404, "Session not found or expired. Start a new one.");
      }
      return namespace.get(id).fetch(forwarded);
    }
    if (request.method !== "POST") return rpcError(400, "No session. Send an initialize request first.");
    return namespace.get(namespace.newUniqueId()).fetch(forwarded);
  }

  async function fetchHandler(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const vars = workerVars(env);
    const guard = guardFor(env);

    if (request.method === "GET" && url.pathname === "/health") return health(request, env);
    if (url.pathname !== WORKER_MCP_PATH) return new Response("Not found", { status: 404 });

    // The server answers with the API credentials in its secrets, so it never
    // serves without a token, the way the Node server refuses to bind wider
    // than loopback without one.
    const authToken = (vars["MCP_AUTH_TOKEN"] ?? "").trim();
    if (authToken === "") {
      return rpcError(503, "MCP_AUTH_TOKEN is not set. Run `npx wrangler secret put MCP_AUTH_TOKEN`, then deploy again.");
    }
    const refusal = httpRequestRefusal(headerMap(request), { ...guard, authToken });
    if (refusal !== null) {
      const { status, headers } = refusalResponse(refusal);
      return json(status, JSON.stringify({ error: `Forbidden: ${refusal}` }), headers);
    }

    return toSession(request, env, undefined);
  }

  /** `/mcp` in OAuth mode: the provider has checked the access token and decrypted its props. */
  async function oauthApiHandler(request: Request, env: WorkerEnv, ctx: OAuthContextLike): Promise<Response> {
    if (new URL(request.url).pathname !== WORKER_MCP_PATH) return new Response("Not found", { status: 404 });
    const refusal = httpRequestRefusal(headerMap(request), guardFor(env));
    if (refusal !== null) return json(403, JSON.stringify({ error: `Forbidden: ${refusal}` }));
    const grant = parseGrant(ctx.props);
    // A token from another app on the same KV namespace, or a grant written
    // before this shape: sign in again.
    if (grant === undefined) return rpcError(401, "This access token carries no credentials. Sign in again.");
    return toSession(request, env, grant);
  }

  const fields = credentialVars.map((name) => ({
    name,
    label: credentialLabel(name, envPrefix),
    secret: !name.endsWith("_USERNAME"),
  }));

  async function renderConsent(
    oauth: OAuthHelpersLike,
    authRequest: OAuthAuthRequestLike,
    handle: string,
    headers: Headers,
    error?: string,
  ): Promise<Response> {
    const details = await oauth.describeConsent(authRequest);
    const page = consentPage({ serverName: branding.name, details, handle, fields, ...(error !== undefined ? { error } : {}) });
    headers.set("Content-Type", "text/html; charset=utf-8");
    // No scripts, no images, nothing loaded: the page is its own inline CSS.
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(page, { status: error !== undefined ? 400 : 200, headers });
  }

  /** A plain-text page, for a consent request that cannot go back to the client. */
  function consentError(message: string): Response {
    return new Response(message, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /**
   * The consent page. GET shows it; POST is its form, sent to the same URL, so
   * the authorization request is parsed from the query string the provider
   * validated rather than from anything the form carries.
   */
  async function authorize(request: Request, oauth: OAuthHelpersLike): Promise<Response> {
    if (fields.length === 0) return consentError("This server takes no credentials, so there is nothing to sign in with.");
    try {
      const authRequest = await oauth.parseAuthRequest(request);
      if (request.method === "GET") {
        const consent = await oauth.beginConsent(authRequest);
        return await renderConsent(oauth, authRequest, consent.handle, consent.headers);
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const credentials: Record<string, string> = {};
      for (const field of fields) {
        const value = String(form.get(field.name) ?? "").trim();
        // Not consumed yet, so the same handle serves the form again.
        if (value === "") {
          return await renderConsent(oauth, authRequest, handle, new Headers({ "Cache-Control": "no-store" }), `Enter your ${field.label}.`);
        }
        credentials[field.name] = value;
      }
      const approved = await oauth.approveConsent(request, handle);
      const owner = crypto.randomUUID();
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: owner,
        metadata: {},
        scope: approved.request.scope,
        props: { owner, credentials },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (err: unknown) {
      // The provider's AuthorizationError and CimdFetchError, matched by name:
      // this package does not import the provider.
      const error = err as { name?: unknown; redirectTo?: unknown; description?: unknown };
      if (error.name === "AuthorizationError" && typeof error.redirectTo === "string") {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error.name === "AuthorizationError") {
        return consentError(typeof error.description === "string" ? error.description : "This sign-in request is not valid.");
      }
      if (error.name === "CimdFetchError") return consentError("This app could not be verified.");
      throw err;
    }
  }

  /** Everything but `/mcp` in OAuth mode: the health check and the consent page. */
  async function oauthDefaultHandler(request: Request, env: WorkerOAuthEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return health(request, env);
    if (url.pathname === WORKER_AUTHORIZE_PATH) return authorize(request, env.OAUTH_PROVIDER);
    // `/mcp` without a valid token never gets here: the provider answers it
    // with the 401 challenge that starts the client's sign-in.
    return new Response("Not found", { status: 404 });
  }

  /** One client session: its server, kept in memory while the object runs. */
  class McpSession implements McpSessionObject {
    private server: Server | undefined;
    private transport: WebStandardStreamableHTTPServerTransport | undefined;
    private reporter: UsageReporter | undefined;
    /** The grant the session was opened under, in OAuth mode. */
    private owner: string | undefined;
    private lastSeen = 0;

    constructor(
      private readonly state: DurableObjectStateLike,
      private readonly env: Record<string, unknown>,
    ) {}

    async fetch(request: Request): Promise<Response> {
      this.lastSeen = Date.now();
      try {
        const grant = grantFromHeader(request);
        const inner = withGrant(request, undefined);
        if (this.transport !== undefined) {
          // A session id is not a credential: a request for a session opened
          // under another grant, or under none, is told it does not exist.
          if (grant?.owner !== this.owner) return rpcError(404, "Session not found or expired. Start a new one.");
          return await this.transport.handleRequest(inner);
        }
        // A session id this object no longer holds: it restarted, or it was
        // closed. 404 is the spec's signal to start a new session.
        if ((request.headers.get("mcp-session-id") ?? "") !== "") {
          return rpcError(404, "Session not found or expired. Start a new one.");
        }
        return await this.open(inner, grant);
      } catch (err: unknown) {
        logLine(`Streamable HTTP error: ${String(err)}`);
        return json(500, JSON.stringify({ error: "Internal server error" }));
      }
    }

    /** Opens the session on its initialize request. */
    private async open(request: Request, grant: WorkerGrant | undefined): Promise<Response> {
      const source: EnvSource = { prefix: envPrefix, vars: sessionVars(this.env, grant, credentialVars) };
      const config = loadConfig([], source, octri !== undefined ? { apiUrl: octri.apiUrl } : {});
      const reporter = config.telemetry && octri !== undefined ? new UsageReporter(octri.apiUrl) : undefined;
      const server = createServer({
        source: { kind: "static", manifest, ...(octri !== undefined ? { octri } : {}) },
        branding,
        env: source,
        permissions: config.permissions,
        ...(reporter !== undefined ? { reporter } : {}),
        ...(config.group !== undefined ? { group: config.group } : {}),
        ...(config.toolMode !== undefined ? { toolMode: config.toolMode } : {}),
        practice: config.practice,
        // Scripts run in this isolate, with the interpreters' own limits and a smaller heap.
        ...(codeSandbox !== undefined ? { codeSandbox, codeLimits: WORKER_SANDBOX_LIMITS } : {}),
        // Workers forbid compiling code at runtime, which the default (Ajv)
        // does to check an approval prompt's answer.
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        // The object's own id, so the next request finds its way back here.
        sessionIdGenerator: () => this.state.id.toString(),
      });
      transport.onclose = () => void this.close();
      // See transports.ts: the SDK's own types disagree on `onclose`.
      await server.connect(transport as Transport);
      const response = await transport.handleRequest(request);
      if (transport.sessionId === undefined) {
        // Not an initialize request: refused, and no session was opened.
        await server.close().catch(() => undefined);
        return response;
      }
      this.server = server;
      this.transport = transport;
      this.reporter = reporter;
      this.owner = grant?.owner;
      await this.state.storage.setAlarm(Date.now() + HTTP_SESSION_IDLE_MS);
      return response;
    }

    /** Closes an idle session, or checks again when it was used since. */
    async alarm(): Promise<void> {
      if (this.transport === undefined) return;
      const idleFor = Date.now() - this.lastSeen;
      if (idleFor >= HTTP_SESSION_IDLE_MS) {
        await this.close();
        return;
      }
      await this.state.storage.setAlarm(this.lastSeen + HTTP_SESSION_IDLE_MS);
    }

    private async close(): Promise<void> {
      const { server, transport, reporter } = this;
      if (transport === undefined) return;
      // Cleared first: closing the transport calls back into onclose.
      this.server = undefined;
      this.transport = undefined;
      this.reporter = undefined;
      this.owner = undefined;
      await transport.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      if (reporter !== undefined) this.state.waitUntil(reporter.flush());
      await this.state.storage.deleteAlarm().catch(() => undefined);
    }
  }

  return {
    fetch: fetchHandler,
    McpSession,
    oauth: {
      api: { fetch: oauthApiHandler },
      fetch: oauthDefaultHandler,
    },
  };
}
