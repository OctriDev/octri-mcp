# @octri/mcp

**An MCP server that turns your API documentation into tools an AI assistant can
call.** Claude, Cursor, VS Code Copilot, and any other MCP client can search your
endpoints, open a guide, pull a ready-to-use SDK snippet in any supported
language, and check the changelog for breaking changes, all from the same
OpenAPI spec your docs are built from.

Octri turns an OpenAPI spec into a documentation site, client SDKs for ten
languages, an MCP server your AI assistant can call, and monitoring for the
API behind them. This package is the MCP server. See
[octri.dev/mcp](https://octri.dev/mcp).

Node 20 or newer. Runs over stdio for a local client, or Streamable HTTP when
you host it.

## Install

```bash
npx -y @octri/mcp
```

Most clients are configured with that command, so a global install is optional.
The Installation section below has the exact config block for each one.

## Tools

| Tool | Description |
|------|-------------|
| `search_docs` | Search the API documentation for an endpoint or concept |
| `get_endpoint` | Get full documentation for a specific API endpoint |
| `list_endpoints` | List all available API endpoints, optionally filtered by section |
| `get_changelog` | Get recent API changes and breaking changes |
| `list_sdks` | List the available SDK client libraries (languages, versions, download links) |
| `get_guide` | Get the full content of a written guide by its slug |
| `get_sdk_methods` | Get ready-to-use SDK code snippets for each endpoint in every supported language |

---

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "my-api-docs": {
      "command": "npx",
      "args": ["@octri/mcp", "--project-id", "YOUR_PROJECT_ID"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "my-api-docs": {
      "command": "npx",
      "args": ["@octri/mcp"],
      "env": {
        "OCTRI_PROJECT_ID": "YOUR_PROJECT_ID"
      }
    }
  }
}
```

### VS Code (Copilot / MCP extension)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "my-api-docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["@octri/mcp", "--project-id", "YOUR_PROJECT_ID"]
    }
  }
}
```

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OCTRI_PROJECT_ID` | Yes* | — | The project to connect to. Can also be set via `--project-id` CLI flag. |
| `OCTRI_API_URL` | No | `https://api.octri.dev/api/v1` | Override the API base URL (useful for self-hosted deployments). |
| `MCP_TRANSPORT` | No | `stdio` | `http` for remote hosting (Streamable HTTP), or `sse` for the legacy transport. |
| `PORT` | No | `3000` | HTTP port for the `http` and `sse` transports. |
| `MCP_HOST` | No | `127.0.0.1` | Interface to bind. Widen only behind a proxy you control. |
| `MCP_ALLOWED_ORIGINS` | No | — | Comma-separated browser origins allowed to reach an HTTP transport. |

\* Required unless every tool call passes `projectId` explicitly.

### Credentials for the API being called

Operation tools call your real API, and these supply its credentials:

| Variable | Description |
|----------|-------------|
| `OCTRI_API_BASE_URL` | Target API base for operation calls (falls back to the studio's Base URL). |
| `OCTRI_API_TOKEN` | Bearer / OAuth2 token. |
| `OCTRI_API_KEY` (+ `OCTRI_API_KEY_HEADER`) | API-key value, and the header it goes in (default `X-API-Key`). |
| `OCTRI_API_USERNAME` / `OCTRI_API_PASSWORD` | Basic-auth credentials. |

All of these are sent as **HTTP headers**. An API that takes its credentials in
the request *body* instead — Plaid's `client_id` and `secret`, for example — is
not served by them: those are ordinary body fields, so they appear as tool
arguments and the agent passes them like any other field. Setting
`OCTRI_API_KEY` for such an API adds a header it ignores.

---

## Remote hosting

Use **Streamable HTTP** (`MCP_TRANSPORT=http`), the transport the MCP spec has
defined for remote servers since revision 2025-03-26 and the one a current
client tries first:

```bash
docker build -t octri-mcp .

docker run -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e OCTRI_PROJECT_ID=YOUR_PROJECT_ID \
  octri-mcp
```

It serves a single endpoint — `POST /mcp` — and runs statelessly, so requests
carry no session and any number of replicas can sit behind a load balancer.
Point a remote MCP client at `http://your-host:3000/mcp`.

### Legacy HTTP+SSE transport

`MCP_TRANSPORT=sse` serves the older 2024-11-05 design, kept so existing
deployments keep working. It exposes `GET /sse` to open a connection and
`POST /messages?sessionId=<id>` to relay client messages. Prefer `http` for
anything new.

### Binding and origins

Both HTTP transports bind `127.0.0.1` by default and refuse any request whose
`Origin` is not listed in `MCP_ALLOWED_ORIGINS`, or whose `Host` is not
loopback. This server holds your API credentials, and any page the browser
visits can reach a loopback port — so widen `MCP_HOST` only behind a proxy you
control, and list origins explicitly.

---

## Local development

```bash
# Build
pnpm build

# Run in stdio mode
OCTRI_PROJECT_ID=my-project node dist/index.js

# Run in Streamable HTTP mode (POST /mcp)
MCP_TRANSPORT=http OCTRI_PROJECT_ID=my-project node dist/index.js

# Run in the legacy SSE mode
MCP_TRANSPORT=sse OCTRI_PROJECT_ID=my-project node dist/index.js
```

---

## Publishing

```bash
pnpm build
npm publish --access public
```

Requires an npm account with access to the `@octri` scope.

---

## The rest of Octri

| Product | What it does |
|---|---|
| [API Studio](https://octri.dev/api-studio) | Your OpenAPI spec becomes a hosted documentation site with a live request playground, editable page by page. |
| [SDK Studio](https://octri.dev/sdk-studio) | The same spec becomes client libraries for ten languages, versioned and released together. |
| [MCP](https://octri.dev/mcp) | Your endpoints and docs become tools an AI assistant can call, generated from the same spec. |
| [Monitoring](https://octri.dev/monitoring) | Errors, traces, uptime and releases for the API, joined to the SDK calls that reached it. |

### Monitoring runtimes

[Node](https://github.com/octridev/octri-node) ·
[Python](https://github.com/octridev/octri-python) ·
[Go](https://github.com/octridev/octri-go) ·
[Ruby](https://github.com/octridev/octri-ruby) ·
[Rust](https://github.com/octridev/octri-rust) ·
[PHP](https://github.com/octridev/octri-php) ·
[Java](https://github.com/octridev/octri-java) ·
[Kotlin](https://github.com/octridev/octri-kotlin) ·
[Swift](https://github.com/octridev/octri-swift) ·
[Dart](https://github.com/octridev/octri-dart)

[Documentation](https://docs.octri.dev/docs) ·
[Pricing](https://octri.dev/pricing) ·
[Changelog](https://docs.octri.dev/changelog)

MIT licensed.
