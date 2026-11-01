// Bundles the compiled server with its dependencies into single files.
//
// An MCP Bundle (`.mcpb`) is installed by unzipping it: there is no `npm
// install`, so a Node server has to carry every module it imports. Copying
// node_modules would mean copying pnpm's symlinked tree; one file per entry
// point carries the MCP SDK and zod instead.
//
//   bundle/core.js         the library the dashboard's customer bundles import
//   bundle/server.js       the `octri-mcp` command, for this package's own bundle
//   bundle/worker-core.js  the Cloudflare Worker host, for a customer's Worker project
//   bundle/code-sandbox-thread.js  one code mode script, on its own worker thread
//   bundle/vendor/*.wasm   the code mode interpreters, read beside the bundle
//
// Runs after `tsc`, from dist/. bundle/ is not in package.json `files`, so the
// npm package does not grow.

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Bundled CommonJS dependencies still call `require` for Node built-ins. */
const banner = {
  js: 'import { createRequire as __octriCreateRequire } from "node:module";\nconst require = __octriCreateRequire(import.meta.url);',
};

await build({
  absWorkingDir: root,
  entryPoints: { core: "dist/core.js", server: "dist/mcpb.js", "code-sandbox-thread": "dist/code-sandbox-thread.js" },
  outdir: "bundle",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "linked",
  banner,
  // The keychain store is a native module, which a single file cannot carry.
  // Its import is optional and caught (src/keychain.ts); a bundle's client
  // passes the credential in its own settings instead.
  external: ["@napi-rs/keyring"],
  logLevel: "warning",
});

// A Worker has no Node HTTP server and no `require`: build it for the browser
// platform, so any Node import that slips into the Worker's path fails here
// rather than at `wrangler deploy`. `Buffer` and `process` are globals there
// under the `nodejs_compat` flag the project's wrangler.jsonc sets.
//
// config.ts reads the package version through `node:module`; a Worker always
// passes its own branding, so that read gets a stub and falls back to 0.0.0.
const stubNodeModule = {
  name: "stub-node-module",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^node:module$/ }, () => ({ path: "node:module", namespace: "stub" }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: 'export function createRequire() { return () => { throw new Error("no require in a Worker"); }; }',
      loader: "js",
    }));
  },
};

await build({
  absWorkingDir: root,
  entryPoints: { "worker-core": "dist/worker.js" },
  outdir: "bundle",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  minify: true,
  legalComments: "linked",
  plugins: [stubNodeModule],
  logLevel: "warning",
});

// A bundle has no node_modules to resolve the interpreters from: they sit in
// bundle/vendor/, where code-sandbox-node.ts looks first.
mkdirSync(`${root}bundle/vendor`, { recursive: true });
copyFileSync(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm"), `${root}bundle/vendor/quickjs.wasm`);
copyFileSync(`${root}vendor/octri-python/octri-python.wasm`, `${root}bundle/vendor/octri-python.wasm`);
