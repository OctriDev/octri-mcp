// Packs this server as an MCP Bundle (`octri-mcp-<version>.mcpb`) and points
// server.json at it.
//
// An MCP Bundle is one file a person opens to install the server in Claude
// Desktop (and other clients that read the format): the client asks for the
// project id and the API's credentials, keeping secrets in the system keychain,
// and runs the server with its own Node. Nothing is installed from npm.
//
//   pnpm build && node scripts/pack-mcpb.mjs
//
// Then, in this order:
//   1. npm publish
//   2. gh release upload v<version> octri-mcp-<version>.mcpb   (the octri-mcp repo)
//   3. mcp-publisher publish
// The MCP Registry lists the bundle by its GitHub release URL and sha256, so
// step 2 has to happen before step 3, with exactly the file this script wrote.

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { packExtension } from "@anthropic-ai/mcpb";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const pkg = read("package.json");
const server = read("server.json");

const { version } = pkg;
const fileName = `octri-mcp-${version}.mcpb`;
const releaseUrl = `https://github.com/octridev/octri-mcp/releases/download/v${version}/${fileName}`;

const config = (key) => `\${user_config.${key}}`;

const manifest = {
  manifest_version: "0.3",
  name: "octri-mcp",
  display_name: server.title,
  version,
  description: pkg.description,
  long_description: `Search an Octri project's API docs and call its endpoints as tools, shaped by its SDK Studio config.

Tools that change data ask you to approve each call before it is sent.

Each tool call reports the tool's name, whether it succeeded, how long it took and the client's name to the project's owner. It never sends arguments or responses.`,
  author: { name: "Octri", url: "https://octri.dev" },
  repository: { type: "git", url: "https://github.com/octridev/octri-mcp" },
  homepage: "https://octri.dev",
  support: "https://octri.dev/support",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        OCTRI_PROJECT_ID: config("project_id"),
        OCTRI_API_TOKEN: config("api_token"),
        OCTRI_API_KEY: config("api_key"),
        OCTRI_API_KEY_HEADER: config("api_key_header"),
        OCTRI_API_USERNAME: config("username"),
        OCTRI_API_PASSWORD: config("password"),
        OCTRI_API_BASE_URL: config("base_url"),
        OCTRI_GROUP: config("group"),
      },
    },
  },
  // Every tool comes from the project, read when the server starts.
  tools_generated: true,
  prompts_generated: true,
  keywords: pkg.keywords,
  license: pkg.license,
  privacy_policies: ["https://octri.dev/privacy"],
  compatibility: { runtimes: { node: pkg.engines.node } },
  user_config: {
    project_id: {
      type: "string",
      title: "Project ID",
      description: "The Octri project whose docs and endpoints to serve. Shown on the project's MCP page.",
      required: true,
    },
    api_token: {
      type: "string",
      title: "API token",
      description: "Bearer or OAuth2 token for the documented API, not for Octri. Leave empty if the API uses a key or no auth.",
      sensitive: true,
    },
    api_key: {
      type: "string",
      title: "API key",
      description: "API key for the documented API, not for Octri.",
      sensitive: true,
    },
    api_key_header: {
      type: "string",
      title: "API key header",
      description: "The header that carries the API key.",
      default: "X-API-Key",
    },
    username: {
      type: "string",
      title: "Username",
      description: "Basic-auth username for the documented API.",
    },
    password: {
      type: "string",
      title: "Password",
      description: "Basic-auth password for the documented API.",
      sensitive: true,
    },
    base_url: {
      type: "string",
      title: "Base URL",
      description: "Where API calls go. Leave empty for the Base URL set in the project's SDK Studio.",
    },
    group: {
      type: "string",
      title: "Tool group",
      description: "Serve only one of the project's tool groups, by its slug. Leave empty for all tools.",
    },
  },
};

// Stage the bundle's files, then let the official packer validate and zip them.
const stage = join(root, ".mcpb-build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
cpSync(join(root, "bundle", "server.js"), join(stage, "server", "index.js"));
cpSync(join(root, "bundle", "server.js.LEGAL.txt"), join(stage, "server", "THIRD_PARTY_NOTICES.txt"));
// The extension folder has no package.json above it, so Node needs this one
// to load the server as an ES module.
writeFileSync(join(stage, "server", "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);

const out = join(root, fileName);
if (!(await packExtension({ extensionPath: stage, outputPath: out, silent: true }))) {
  console.error("mcpb pack refused the bundle; run `npx mcpb validate .mcpb-build` for the reasons.");
  process.exit(1);
}
rmSync(stage, { recursive: true, force: true });

const bytes = readFileSync(out);
const sha256 = createHash("sha256").update(bytes).digest("hex");

// The registry entry: npm first (what most clients run), the bundle beside it.
server.packages = [
  ...server.packages.filter((p) => p.registryType !== "mcpb"),
  {
    registryType: "mcpb",
    identifier: releaseUrl,
    version,
    fileSha256: sha256,
    transport: { type: "stdio" },
  },
];
// Keep one-string arrays (`"sizes": ["any"]`) on one line, as the file has them.
const serverJson = JSON.stringify(server, null, 2).replace(/\[\n\s+("[^"\n]*")\n\s+\]/g, "[$1]");
writeFileSync(join(root, "server.json"), `${serverJson}\n`);

console.log(`${fileName}  ${(bytes.length / 1024).toFixed(0)} KB  sha256 ${sha256}`);
console.log(`server.json now lists ${releaseUrl}`);
console.log(`Next: npm publish, then gh release upload v${version} ${fileName} --repo octridev/octri-mcp, then mcp-publisher publish.`);
