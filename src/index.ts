#!/usr/bin/env node

/**
 * Octri MCP Server
 *
 * Exposes an Octri project to AI assistants (Claude, Cursor, etc.) as MCP tools:
 *   - Docs tools: search, retrieve, and navigate the project's documentation.
 *   - Operation tools: one executable tool per included endpoint, shaped by the
 *     owner's SDK Studio config (names, doc comments, inclusion, deprecation).
 *     These PERFORM the real API call, using credentials from the env below.
 *
 * Commands:
 *   octri-mcp [--project-id <id>]    serve (stdio unless MCP_TRANSPORT says otherwise)
 *   octri-mcp doctor [--no-call]     check the setup end to end and say what to fix
 *
 * Env:
 *   OCTRI_PROJECT_ID / --project-id   the project to expose
 *   OCTRI_API_URL                     the Octri API (defaults to prod)
 *   OCTRI_API_BASE_URL                the TARGET API base for operation calls
 *                                     (falls back to the studio's Base URL)
 *   OCTRI_API_TOKEN                   bearer / oauth2 token (or basic creds)
 *   OCTRI_API_KEY (+ _HEADER)         apiKey value (+ header name, def X-API-Key)
 *   OCTRI_API_USERNAME / _PASSWORD    basic-auth credentials
 *
 * Permissions. The project owner publishes one per tool: run on its own, ask
 * the user first, or off (never listed). A tool that asks first is approved
 * through MCP elicitation; a client that cannot ask gets a refusal instead of
 * an unapproved call. The env below can only narrow what the owner allowed,
 * except that it may pre-approve tools that would otherwise ask:
 *   OCTRI_ALLOW_TOOLS / --allow-tools a,b   run these "ask first" tools without asking ("*" = all)
 *   OCTRI_ALLOW_WRITES=1 / --allow-writes   same as OCTRI_ALLOW_TOOLS=*
 *   OCTRI_READ_ONLY=1 / --read-only         list and run only tools that read
 *   OCTRI_DENY_TOOLS / --deny-tools a,b     never list or run these tools
 *   OCTRI_DRY_RUN=1 / --dry-run             build each API call and return it unsent
 *
 * Usage. Each tool call is reported to Octri (tool name, outcome, duration and
 * the client's name; never arguments or responses) so the owner can see which
 * tools agents use. OCTRI_TELEMETRY=0 or --no-telemetry turns it off.
 *
 * All of the above are sent as HTTP HEADERS. An API that takes its credentials
 * in the request body instead (Plaid's `client_id` / `secret`, for one) is not
 * served by them: those fields are ordinary body parameters, so the agent passes
 * them as tool arguments like any other field. Setting OCTRI_API_KEY for such an
 * API adds a header it ignores and changes nothing about whether a call
 * authenticates.
 *
 * Transports:
 *   stdio (default)   for Claude Desktop / Cursor local integrations
 *   http              Streamable HTTP for remote hosting (MCP_TRANSPORT=http).
 *                     The transport the current spec defines: /mcp, one
 *                     session per client (route replicas by mcp-session-id).
 *   sse               legacy HTTP+SSE (MCP_TRANSPORT=sse), superseded in spec
 *                     revision 2025-03-26 and kept for existing deployments.
 *                     New hosting should use `http`.
 *
 * HTTP transport env (http and sse):
 *   PORT                              port to bind (default 3000)
 *   MCP_HOST                          interface to bind (default 127.0.0.1)
 *   MCP_ALLOWED_ORIGINS               comma-separated browser origins allowed
 *                                     to reach the transport (default none)
 *   MCP_AUTH_TOKEN                    bearer token every request must present.
 *                                     Required once MCP_HOST is not loopback.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { processEnv } from "./env.js";
import { createServer } from "./server.js";
import { httpStartupRefusal, startSse, startStdio, startStreamableHttp } from "./transports.js";
import { processUsageReporter } from "./usage.js";

// The library surface, for hosts that build on this package and for the tests.
export * from "./core.js";

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = processEnv();
  const args = process.argv.slice(2);
  const config = loadConfig(args, env);

  // `octri-mcp doctor`: check the setup, print what to fix, exit.
  if (args[0] === "doctor") {
    const checks = await runDoctor({
      source: { kind: "live", apiUrl: config.apiUrl, projectId: config.projectId },
      env,
      permissions: config.permissions,
      telemetry: config.telemetry,
      call: !args.includes("--no-call"),
    });
    process.stdout.write(formatDoctor(checks));
    process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
  }

  if (["http", "streamable-http", "sse"].includes(config.transport)) {
    const refusal = httpStartupRefusal(config);
    if (refusal !== null) throw new Error(refusal);
  }

  const reporter = config.telemetry ? processUsageReporter(config.apiUrl) : undefined;
  const makeServer = () =>
    createServer({
      source: { kind: "live", apiUrl: config.apiUrl, projectId: config.projectId },
      env,
      permissions: config.permissions,
      ...(reporter !== undefined ? { reporter } : {}),
    });

  if (config.transport === "http" || config.transport === "streamable-http") {
    await startStreamableHttp(config, makeServer);
  } else if (config.transport === "sse") {
    await startSse(config, makeServer);
  } else {
    await startStdio(makeServer);
  }
}

/**
 * True when this module is the process entry point, rather than imported by the
 * test suite for the helpers it exports.
 *
 * `import.meta.url` is always the RESOLVED real path, while `process.argv[1]` is
 * the path as invoked, so the two diverge the moment the entry point is reached
 * through a symlink. npm and npx publish `bin` entries as exactly that
 * (`node_modules/.bin/octri-mcp -> ../@octri/mcp/dist/index.js`), so comparing
 * them raw meant `npx @octri/mcp` (the documented install, and the config every
 * client ships) started nothing and exited 0 with no output. Resolving both
 * sides keeps the symlinked shim a direct run.
 */
export function isDirectRun(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry === "") return false;
  if (moduleUrl === pathToFileURL(entry).href) return true;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] need not exist on disk (bundlers, virtual filesystems).
    return false;
  }
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`Fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
