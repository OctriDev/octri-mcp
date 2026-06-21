# @octri/mcp

MCP (Model Context Protocol) server for [Octri](https://octri.dev) API documentation.

Connect your API docs to Claude, Cursor, and any MCP-compatible AI assistant so they can search, navigate, and retrieve your documentation as live context.

---

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
| `MCP_TRANSPORT` | No | `stdio` | Set to `sse` for remote/Docker hosting. |
| `PORT` | No | `3000` | HTTP port when using SSE transport. |

\* Required unless every tool call passes `projectId` explicitly.

---

## Remote hosting (Docker / SSE transport)

The server supports SSE (Server-Sent Events) transport for remote deployment:

```bash
docker build -t octri-mcp .

docker run -p 3000:3000 \
  -e OCTRI_PROJECT_ID=YOUR_PROJECT_ID \
  octri-mcp
```

The container exposes two endpoints:

- `GET /sse` — opens an SSE connection (configure this URL in your MCP client)
- `POST /messages?sessionId=<id>` — relay endpoint for client-to-server messages

Configure a remote MCP client to connect to `http://your-host:3000/sse`.

---

## Local development

```bash
# Build
pnpm build

# Run in stdio mode
OCTRI_PROJECT_ID=my-project node dist/index.js

# Run in SSE mode
MCP_TRANSPORT=sse OCTRI_PROJECT_ID=my-project node dist/index.js
```

---

## Publishing

```bash
pnpm build
npm publish --access public
```

Requires an npm account with access to the `@octri` scope.
