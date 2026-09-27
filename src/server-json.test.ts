import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  packages: { identifier: string; version: string }[];
};

describe("server.json", () => {
  it("is registered under the manifest's mcpName", () => {
    assert.equal(server.name, manifest.mcpName);
  });

  it("carries the manifest version, top level and per package", () => {
    assert.equal(server.version, manifest.version);
    for (const entry of server.packages) {
      assert.equal(entry.identifier, manifest.name);
      assert.equal(entry.version, manifest.version);
    }
  });
});
