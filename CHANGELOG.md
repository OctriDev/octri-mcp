# Changelog

## 1.4.2

- The docs tools read what the docs site serves. `list_endpoints` walks every
  tab of the navigation, not only the first, and above 150 endpoints it lists
  the sections and asks for one instead of returning a listing too long to
  use. `get_endpoint` reads the page's documentation, which it used to miss.
  `get_guide` finds a guide from its slug alone. `get_sdk_methods` with no
  endpoint lists one line per method to pick from, without the code.
- Python code mode: a script that recurses without end now fails with
  `RuntimeError: maximum recursion depth exceeded` wherever it runs. When the
  sandbox ran on a host thread with a small stack, it came back as the
  interpreter crashing.

## 1.4.1

- `--skip-prompts` / `OCTRI_SKIP_PROMPTS` leaves the named prompts out of
  `prompts/list` and `prompts/get`. A project's Claude Code plugin passes the
  prompts it already ships as slash commands, so each appears once in
  Claude Code's `/` menu.

## 1.4.0

- Tool listings: `--tool-mode` / `OCTRI_TOOL_MODE` takes `all`, `search`, `code`
  or `auto` and wins over the owner's published mode. `search` lists
  `search_tools`, `describe_tool` and `call_tool` in place of one tool per
  endpoint (on the GitHub REST API, `tools/list` drops from about 403,000
  tokens to about 1,500); `auto` switches to it above the owner's threshold.
- Code mode: `describe_sdk` shows the API as TypeScript declarations or Python
  stubs, and `run_code` runs a short script against it in a sandbox (QuickJS
  for TypeScript, MicroPython for Python, both WebAssembly). Every SDK call a
  script makes goes through the normal tool call path, so permissions,
  approval prompts, practice mode, limits and usage apply to each one.
- Practice mode (`--practice` / `OCTRI_PRACTICE`): every API tool answers with
  fake data built from the docs, nothing is sent, and within a session created
  records show up in later reads. `practice_control` arms an error or resets
  the session.
- Owner content beyond one tool per endpoint: chained tools (one approval
  lists every request), prompts, and resources (the pruned OpenAPI spec and
  chosen guides). Tool groups are served as separate servers (`--group` /
  `OCTRI_GROUP`), and the owner's per-tool names, descriptions, hidden fields
  and pinned values apply everywhere.
- Outage-aware tools: a tool whose endpoint Octri's uptime checks see failing
  says so before it is called, and a call that fails during that outage
  returns a structured "known outage, retry later" result. Opt out with
  `OCTRI_OUTAGE_STATUS=0`.
- A failed call comes back with a short guide on how to fix it (the endpoint's
  own error docs first, then the project's guidance, then a built-in hint per
  status) and the same facts as structured data.
- What changed: agents get a note on each tool that changed since they last
  connected, a `what_changed` tool, and a pointer to the new name when they
  call a renamed or removed tool. npm and bundle servers keep their place in
  a small state file.
- Limits set by the owner: writes per session and calls per minute per tool. A
  refused call returns `limit_reached` with the cap and a retry time; writes
  are posted to the project's audit log with arguments redacted.
- `octri-mcp login` / `logout` keep the credential in the system keychain
  (optional `@napi-rs/keyring`). Results, errors, approval prompts and dry
  runs drop the session's credentials, also when an API echoes them.
- Approval prompts go out on the tool call's own stream, so a client that
  never opens the standalone GET stream no longer waits for them to time out.
- An empty or blank setting now reads as unset on every entry point, not only
  the MCP Bundle; `"OCTRI_API_BASE_URL": ""` in a client config no longer beats
  the project's base URL.
- A missing or wrong `MCP_AUTH_TOKEN` is now answered with 401 and a Bearer
  challenge on every HTTP transport (was 403 on Node and Docker); 403 stays for
  an origin or host the server will not answer.
- An MCP Bundle per release (`octri-mcp-<version>.mcpb`, attached to the
  GitHub release and listed in `server.json`): open it in Claude Desktop to
  install the server, which asks for the project ID and credentials itself.
  `pnpm pack:mcpb` builds it.
- `dropUnsetConfig(prefix)` in the library: drops settings an MCP Bundle's
  client passed empty or unfilled, so they read as unset.
- `GET /health` on the Streamable HTTP transport, answered without the bearer
  token, for container and load balancer probes.
- A Cloudflare Worker host (`dist/worker.js`, bundled as `bundle/worker-core.js`):
  sessions as Durable Objects, so approval prompts work on Workers. Used by the
  Worker projects the dashboard generates per release.
- Worker OAuth consent mode (opt-in, `wrangler.oauth.jsonc`): each user signs
  in on a consent page and enters their own API key, kept encrypted in the
  grant. The shared `MCP_AUTH_TOKEN` mode stays the default.
- Docker image: Node 24, runs as a non-root user, has a health check, and the
  README's `docker run` now sets `MCP_AUTH_TOKEN`. Without it the image's
  all-interfaces bind made the server refuse to start, as designed.
- The Docker image builds again and ships code mode's Python interpreter
  (`vendor/`); without it the TypeScript build failed.

## 1.3.0

- Tool permissions. Each operation tool carries the policy its project owner
  published: run on its own, ask first, or off. An "ask first" call is built,
  shown to the user through MCP elicitation (method, URL, a short body excerpt)
  and sent only on approval. A client without elicitation gets a refusal, not
  an unapproved call. Payloads without a policy get the same default: reads run,
  everything else asks.
- End-user limits: `OCTRI_READ_ONLY` / `--read-only`, `OCTRI_DENY_TOOLS` /
  `--deny-tools`, and `OCTRI_ALLOW_TOOLS` / `--allow-tools` or
  `OCTRI_ALLOW_WRITES` / `--allow-writes` to pre-approve "ask first" tools. None
  of them can bring back a tool the owner turned off.
- `OCTRI_DRY_RUN` / `--dry-run` builds each API call and returns it unsent.
- Every non-read operation tool now reports `destructiveHint: true` unless the
  owner marks it as only adding data. Previously only DELETE did.
- Each tool call reports its tool name, outcome, duration and client name (never
  arguments or responses) so owners see per-tool agent usage. Turn it off with
  `OCTRI_TELEMETRY=0` or `--no-telemetry`.
- The server is now a library as well as a command: `createServer` takes a live
  tool source (the Octri API) or a static manifest, a server name, and an env
  prefix, so a host can serve the same tools under its own name and variables.
  The `octri-mcp` command, its flags and its env vars are unchanged.
- `octri-mcp doctor` checks a setup end to end (project, tools, base URL,
  credentials, one real read call) and says what to fix. `--no-call` skips the
  call. Exits non-zero on a failure, so it also runs in CI.
- Streamable HTTP (`MCP_TRANSPORT=http`) now keeps a session per client
  (`mcp-session-id`), so an "ask first" tool can be approved over HTTP: the
  answer to its prompt arrives on a later request and now reaches the server
  that asked. Previously every request got a fresh server, and such a call
  waited out its approval timeout. Idle sessions close after 30 minutes. Behind
  several replicas, route by `mcp-session-id`.
- `createServer` takes a `fetch` for operation calls, so a host can route them
  through its own network policy.
- `zod` is now a declared dependency. It was already a required peer of the
  MCP SDK; declaring it lets workspace consumers link this package.

## 1.2.2

- Explicit `application/x-www-form-urlencoded` `deepObject` fields with
  `explode: true` now serialize as bracketed keys. Stripe customer fields such
  as `invoice_settings`, `cash_balance`, `preferred_locales`, and `tax_id_data`
  now reach documented endpoint, including nested objects and arrays.
  Unsupported `deepObject` `explode: false`, form part headers/content types,
  and other styles still fail before any upstream request.

## 1.2.1

- Operation tools retain documented request media, parameter locations, and
  serialization. JSON/+json, JSON Patch, form, multipart, text, and bounded
  inline binary bodies reach their documented wire format. Multipart and binary
  files accept only `{ filename, content: base64, contentType? }`; server never
  reads local paths or fetches URLs for tool arguments.
- Declared header and cookie parameters, query arrays, and provider-specific
  Slack `{"ok":false,"error":"..."}` error envelopes now reach MCP execution correctly.
- Explicit form `style: form` supports scalar arrays and objects with explode
  controls. Unsupported form directives and multipart style/explode/part headers
  fail before the upstream call; multipart part content types are supported.
- Inline files are limited to 10 MiB decoded; transport request limits can
  impose a lower bound on incoming JSON messages.

## 1.2.0

- An HTTP transport bound beyond loopback (`MCP_HOST` set to anything but
  `127.0.0.1`, `localhost` or `::1`) now requires `MCP_AUTH_TOKEN`, and every
  request must send `Authorization: Bearer <token>`. Without it the server
  refuses to start. Every call this server makes uses your API credentials, so
  anyone who could reach the port could use them. **Breaking** for deployments
  that widen `MCP_HOST`: set the token, and the same header in your client.
  stdio and loopback-only setups are unaffected.

## 1.1.1

- Listed in the official MCP Registry as `dev.octri/mcp`. `package.json` carries
  the `mcpName` the registry checks ownership against, and `server.json`
  describes the stdio launch and its environment variables for clients that
  install from the registry. No change to the server itself.

## 1.1.0

- `npx @octri/mcp` starts again. The entry-point guard compared the path the
  process was invoked with against this module's resolved path. npm and npx
  publish `bin` entries as symlinks, so the two never matched: `main()` never
  ran, and the server exited 0 without a word. Every client config in the docs
  was affected.
- A body-bearing method always sends a JSON body, `{}` when nothing was filled
  in. Sending none while announcing `Content-Type: application/json` reads to a
  strict API as an unparseable payload, not an absent one, and the call failed
  on the body before the route was considered.
- An upstream 4xx or 5xx is reported as `isError`, so a model can tell a failed
  call from data it can use.
- Required arguments are checked before the request goes out; a missing one is
  named instead of becoming an empty path segment and a 404.
- `projectId` is no longer marked required on the documentation tools. The
  server already knows its own project, and demanding one pushed the model to
  invent an id that silently reads somebody else's project.
- New Streamable HTTP transport (`MCP_TRANSPORT=http`, `POST /mcp`, stateless),
  the transport the spec has defined for remote servers since revision
  2025-03-26 and the one a current client tries first. The HTTP+SSE pair stays
  for existing deployments; the Docker image now defaults to `http`.
- Operation tools carry MCP tool annotations, so a client can tell a GET that
  only reads from a DELETE that does not.
- A tool list that cannot be fetched says so on stderr instead of quietly
  serving the seven documentation tools, errors reach the model as advice
  rather than an internal URL and a raw payload, and the handshake reports the
  real package version instead of a pinned 1.0.0.

## 1.0.1

- The SSE transport now checks `Host` and `Origin` and binds to `127.0.0.1` by
  default, which closes a DNS-rebinding path from any page the developer
  happened to have open. `MCP_HOST` and `MCP_ALLOWED_ORIGINS` widen it when you
  really are serving other machines.
- An operation path can no longer leave the configured base URL. A spec that
  pointed a path at another origin, or smuggled credentials through a userinfo
  segment, used to be followed.
- Responses are capped at 1 MB, operations time out after 30s, and the tool
  cache and SSE session table are both bounded.

## 1.0.0

First public release.

- Executes an Octri project's generated operations as MCP tools.
- stdio and SSE transports.
