# Changelog

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
