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
 *   octri-mcp login  [--project-id <id>]  save the API credential in the system keychain
 *   octri-mcp logout [--project-id <id>]  remove it
 *
 * Env:
 *   OCTRI_PROJECT_ID / --project-id   the project to expose
 *   OCTRI_GROUP / --group <slug>      serve only this tool group of the project
 *   OCTRI_SKIP_PROMPTS / --skip-prompts <a,b>  leave these prompts out (a plugin's commands)
 *   OCTRI_API_URL                     the Octri API (defaults to prod)
 *   OCTRI_API_BASE_URL                the TARGET API base for operation calls
 *                                     (falls back to the studio's Base URL)
 *   OCTRI_API_TOKEN                   bearer / oauth2 token (or basic creds)
 *   OCTRI_API_KEY (+ _HEADER)         apiKey value (+ header name, def X-API-Key)
 *   OCTRI_API_USERNAME / _PASSWORD    basic-auth credentials
 *
 * Credentials set in the env win. Without any, the server reads the one
 * `login` saved in the system keychain (see keychain.ts), so the client's
 * config can carry none.
 *
 * Permissions. The project owner publishes one per tool: run on its own, ask
 * the user first, or off (never listed). A tool that asks first is approved
 * through MCP elicitation; a client that cannot ask gets a refusal instead of
 * an unapproved call. The env below can only narrow what the owner allowed,
 * except that it may pre-approve tools that would otherwise ask:
 *   OCTRI_ALLOW_TOOLS / --allow-tools a,b   run these "ask first" tools without asking ("*" = all;
 *                                           tool name or endpoint slug)
 *   OCTRI_ALLOW_WRITES=1 / --allow-writes   same as OCTRI_ALLOW_TOOLS=*
 *   OCTRI_READ_ONLY=1 / --read-only         list and run only tools that read
 *   OCTRI_DENY_TOOLS / --deny-tools a,b     never list or run these tools (name, the SDK
 *                                           name before an owner's rename, or endpoint slug)
 *   OCTRI_DRY_RUN=1 / --dry-run             build each API call and return it unsent
 *   OCTRI_PRACTICE=1 / --practice           practice mode: every call answers with fake data
 *                                           built from the API's documentation, nothing is
 *                                           sent and no credential is needed. The owner must
 *                                           turn practice mode on for the project.
 *
 * Tool listing. One tool per endpoint floods a client's context once an API has
 * more than a few dozen of them. Search mode lists search_tools, describe_tool
 * and call_tool (plus list_tool_groups) in their place; every permission above
 * still applies to each call. The project owner picks the mode on the MCP page;
 * this overrides it either way:
 *   OCTRI_TOOL_MODE / --tool-mode all|search|code|auto   auto = search above 40 tools; code = scripts against the SDK
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

import { localChangeState } from "./change-state.js";
import { nodeCodeSandbox } from "./code-sandbox-node.js";
import { loadConfig } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { processEnv } from "./env.js";
import { runLogin, runLogout, systemKeychain, terminalIo, withKeychainCredential } from "./keychain.js";
import { fetchOperationTools } from "./operations.js";
import { createServer } from "./server.js";
import { httpStartupRefusal, startSse, startStdio, startStreamableHttp } from "./transports.js";
import { processUsageReporter } from "./usage.js";

// The library surface, for hosts that build on this package and for the tests.
export * from "./core.js";
export { serializeWholeQuery } from "./operations.js";

// ─── Entry point ───────────────────────────────────────────────────────────────

/** The keychain entry for one project. */
function keychainAccount(projectId: string): string {
  return `project:${projectId}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig(args, processEnv());

  // `octri-mcp login` / `logout`: the credential in the system keychain.
  if (args[0] === "login" || args[0] === "logout") {
    if (config.projectId === "") throw new Error("Pass --project-id <id> (or set OCTRI_PROJECT_ID) so the credential is saved for that project.");
    const store = await systemKeychain("octri-mcp");
    const io = terminalIo();
    try {
      const account = keychainAccount(config.projectId);
      if (args[0] === "logout") process.exitCode = await runLogout({ account, store, envPrefix: "OCTRI", io });
      else {
        // The scheme decides what to ask for.
        const { auth } = await fetchOperationTools(config.apiUrl, config.projectId);
        process.exitCode = await runLogin({ auth, account, envPrefix: "OCTRI", store, io });
      }
    } finally {
      io.close();
    }
    return;
  }

  const { env, source: credentialSource } =
    config.projectId !== ""
      ? await withKeychainCredential(processEnv(), keychainAccount(config.projectId), await systemKeychain("octri-mcp"))
      : { env: processEnv(), source: "none" as const };

  // `octri-mcp doctor`: check the setup, print what to fix, exit.
  if (args[0] === "doctor") {
    const checks = await runDoctor({
      source: { kind: "live", apiUrl: config.apiUrl, projectId: config.projectId },
      env,
      permissions: config.permissions,
      telemetry: config.telemetry,
      call: !args.includes("--no-call"),
      credentialSource,
      ...(config.group !== undefined ? { group: config.group } : {}),
      practice: config.practice,
    });
    process.stdout.write(formatDoctor(checks));
    process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
  }

  if (["http", "streamable-http", "sse"].includes(config.transport)) {
    const refusal = httpStartupRefusal(config);
    if (refusal !== null) throw new Error(refusal);
  }

  const reporter = config.telemetry ? processUsageReporter(config.apiUrl) : undefined;
  // One agent per stdio process, so its place in the release history is kept
  // on this machine. An HTTP server is shared, and starts from recent releases.
  const changeState =
    config.transport === "stdio" && config.projectId !== ""
      ? localChangeState(env, { projectId: config.projectId, group: config.group })
      : undefined;
  // Code mode's sandbox, compiled once per process; the server falls back to
  // search mode if it cannot load.
  const codeSandbox = nodeCodeSandbox();
  const makeServer = () =>
    createServer({
      source: { kind: "live", apiUrl: config.apiUrl, projectId: config.projectId },
      ...(changeState !== undefined ? { changes: changeState } : {}),
      env,
      permissions: config.permissions,
      // Who can fix a refused credential: env, keychain, or nobody set one.
      credentialOrigin: credentialSource,
      ...(reporter !== undefined ? { reporter } : {}),
      ...(config.group !== undefined ? { group: config.group } : {}),
      ...(config.toolMode !== undefined ? { toolMode: config.toolMode } : {}),
      ...(config.skipPrompts.size > 0 ? { skipPrompts: config.skipPrompts } : {}),
      practice: config.practice,
      codeSandbox,
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
