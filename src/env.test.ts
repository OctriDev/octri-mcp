import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "./config.js";
import { dropUnsetConfig, readEnv } from "./env.js";

describe("dropUnsetConfig", () => {
  it("drops this prefix's empty and unfilled settings, and nothing else", () => {
    const vars: NodeJS.ProcessEnv = {
      ACME_API_TOKEN: "tok",
      ACME_GROUP: "",
      ACME_API_KEY_HEADER: "${user_config.api_key_header}",
      OTHER_GROUP: "",
      PATH: "/bin",
    };
    dropUnsetConfig("ACME", vars);
    assert.deepEqual(vars, { ACME_API_TOKEN: "tok", OTHER_GROUP: "", PATH: "/bin" });
  });
});

describe("readEnv", () => {
  it("reads an empty or blank setting as unset, wherever the server runs", () => {
    const env = { prefix: "ACME", vars: { ACME_API_BASE_URL: "", ACME_GROUP: "  ", ACME_API_TOKEN: "tok" } };
    assert.equal(readEnv(env, "API_BASE_URL"), undefined);
    assert.equal(readEnv(env, "GROUP"), undefined);
    assert.equal(readEnv(env, "API_TOKEN"), "tok");
  });

  it("leaves a blank transport setting at its default", () => {
    const config = loadConfig([], { prefix: "ACME", vars: { ACME_API_URL: "", MCP_HOST: "", PORT: "", MCP_TRANSPORT: "" } });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3000);
    assert.equal(config.transport, "stdio");
    assert.notEqual(config.apiUrl, "");
  });
});
