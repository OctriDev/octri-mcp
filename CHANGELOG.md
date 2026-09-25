# Changelog

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
