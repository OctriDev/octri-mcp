# Changelog

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
