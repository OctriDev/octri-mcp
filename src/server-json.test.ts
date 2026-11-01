import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// server.json is what the MCP Registry serves, and it pins the npm version a
// registry install runs. A release that bumps package.json alone keeps sending
// those installs to the previous build, with nothing else to flag it.
const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

const manifest = readJson("package.json") as {
  name: string;
  version: string;
  mcpName: string;
};
const server = readJson("server.json") as {
  name: string;
  version: string;
  packages: { registryType: string; identifier: string; version: string; fileSha256?: string }[];
};

const npm = server.packages.filter((p) => p.registryType === "npm");
const mcpb = server.packages.filter((p) => p.registryType === "mcpb");

describe("server.json", () => {
  it("is registered under the manifest's mcpName", () => {
    assert.equal(server.name, manifest.mcpName);
  });

  it("carries the manifest version, top level and per package", () => {
    assert.equal(server.version, manifest.version);
    for (const entry of npm) {
      assert.equal(entry.identifier, manifest.name);
      assert.equal(entry.version, manifest.version);
    }
  });

  // The bundle entry is written by `pnpm pack:mcpb`. A version bump without a
  // re-pack would list last release's file under this release's version.
  it("lists this version's MCP Bundle on its GitHub release", () => {
    assert.equal(mcpb.length, 1);
    const [entry] = mcpb;
    const file = `octri-mcp-${manifest.version}.mcpb`;
    assert.equal(entry?.identifier, `https://github.com/octridev/octri-mcp/releases/download/v${manifest.version}/${file}`);
    assert.equal(entry?.version, manifest.version);
    assert.match(entry?.fileSha256 ?? "", /^[a-f0-9]{64}$/);
    // When the packed file is here, it is the one the entry names.
    const local = new URL(`../${file}`, import.meta.url);
    if (existsSync(local)) {
      assert.equal(createHash("sha256").update(readFileSync(local)).digest("hex"), entry?.fileSha256);
    }
  });
});
