import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { encodeQuerystring } from "./querystring.js";

describe("whole-query serializer", () => {
  it("retains JSON zero, false, null and empty string values", () => {
    const content = { "application/json": {} };
    for (const value of [0, false, null, ""]) {
      assert.equal(decodeURIComponent(encodeQuerystring(value, content)), JSON.stringify(value));
    }
  });

  it("escapes form data without creating fields or fragments", () => {
    const query = encodeQuerystring({ "field name": "a b+c#d&e=f/[x]" }, {
      "application/x-www-form-urlencoded": { encoding: { "field name": { allowReserved: true } } },
    });
    assert.equal(query, "field+name=a+b%2Bc%23d%26e%3Df/%5Bx%5D");
    assert.deepEqual([...new URLSearchParams(query)], [["field name", "a b+c#d&e=f/[x]"]]);
  });

  const canonical = new URL("../../shared/src/sdk/querystring.ts", import.meta.url);
  it("keeps the self-contained vendored serializer identical to its canonical source", {
    // A standalone clone builds its committed copy without the monorepo.
    skip: !existsSync(canonical),
  }, () => {
    const vendored = readFileSync(new URL("../src/querystring.ts", import.meta.url), "utf8");
    assert.equal(vendored.slice(vendored.indexOf("\n") + 1), readFileSync(canonical, "utf8"));
  });
});
