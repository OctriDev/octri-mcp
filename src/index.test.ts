import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildRequestBody,
  formatChangelog,
  isDirectRun,
  missingRequired,
  operationAnnotations,
  type HttpMapping,
} from "./index.js";

describe("get_changelog release notes", () => {
  const release = {
    revision: 3,
    version: "2.0.0",
    publishedAt: "2026-08-05T00:00:00.000Z",
    changelog: "Move clients to /v2 before upgrading.",
  };

  it("includes published release version and note with normal history", () => {
    const text = formatChangelog([
      {
        id: "history-1",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasBreakingChanges: false,
        generatedAt: "2026-08-01T00:00:00.000Z",
      },
    ], false, release);

    assert.match(text, /Release v2\.0\.0/);
    assert.match(text, new RegExp(release.changelog));
    assert.match(text, /1\.0\.0 → 1\.1\.0/);
  });

  it("does not include release note in breaking-only history", () => {
    const text = formatChangelog([], true, release);

    assert.equal(text, "No breaking changes found in recent history.");
    assert.equal(text.includes(release.changelog), false);
  });
});

describe("entry point detection", () => {
  // npm and npx expose `bin` as a symlink, so the published server was started
  // through one on every `npx @octri/mcp` — and comparing argv[1] to the
  // resolved module URL raw made it boot nothing and exit 0.
  it("treats a symlinked entry point as a direct run", () => {
    const dir = mkdtempSync(join(tmpdir(), "octri-mcp-entry-"));
    try {
      const real = join(realpathSync(dir), "server.js");
      writeFileSync(real, "// server\n");
      const shim = join(realpathSync(dir), "bin-shim.js");
      symlinkSync(real, shim);

      const moduleUrl = pathToFileURL(real).href;

      assert.equal(isDirectRun(real, moduleUrl), true, "real path must run");
      assert.equal(isDirectRun(shim, moduleUrl), true, "symlinked bin must run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run when the entry point is another module", () => {
    const dir = mkdtempSync(join(tmpdir(), "octri-mcp-entry-"));
    try {
      const real = join(realpathSync(dir), "server.js");
      const other = join(realpathSync(dir), "other.js");
      writeFileSync(real, "// server\n");
      writeFileSync(other, "// other\n");

      assert.equal(isDirectRun(other, pathToFileURL(real).href), false);
      assert.equal(isDirectRun(undefined, pathToFileURL(real).href), false);
      assert.equal(isDirectRun("", pathToFileURL(real).href), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when argv[1] is not on disk", () => {
    const missing = join(tmpdir(), "octri-mcp-does-not-exist-xyz.js");
    assert.equal(isDirectRun(missing, pathToFileURL(missing).href), true);
    assert.equal(isDirectRun(missing, "file:///somewhere/else.js"), false);
  });
});

describe("request body construction", () => {
  const http: HttpMapping = {
    method: "POST",
    path: "/categories/get",
    pathParams: [],
    queryParams: [],
    bodyParams: [
      { name: "accessToken", wireName: "access_token" },
      { name: "startDate", wireName: "start_date" },
    ],
    constants: [],
  };

  // A POST with no fields still has to carry `{}`. Sending no body at all while
  // announcing JSON made strict APIs reject the call as unparseable.
  it("sends an empty object for a body-bearing method with no fields", () => {
    const empty: HttpMapping = { ...http, bodyParams: [] };
    assert.equal(buildRequestBody(empty, {}, "POST"), "{}");
    assert.equal(buildRequestBody(empty, { body: {} }, "POST"), "{}");
    assert.equal(buildRequestBody(empty, {}, "PATCH"), "{}");
    assert.equal(buildRequestBody(empty, {}, "put"), "{}");
  });

  it("omits the body entirely for GET and HEAD", () => {
    assert.equal(buildRequestBody(http, { body: { accessToken: "t" } }, "GET"), undefined);
    assert.equal(buildRequestBody(http, {}, "HEAD"), undefined);
  });

  it("maps supplied fields onto their wire names", () => {
    const body = buildRequestBody(http, { body: { accessToken: "tok", startDate: "2026-01-01" } }, "POST");
    assert.deepEqual(JSON.parse(body ?? "null"), {
      access_token: "tok",
      start_date: "2026-01-01",
    });
  });

  it("includes baked body constants", () => {
    const withConstant: HttpMapping = {
      ...http,
      constants: [{ location: "body", wireName: "client_id", value: "abc" }],
    };
    assert.deepEqual(JSON.parse(buildRequestBody(withConstant, {}, "POST") ?? "null"), {
      client_id: "abc",
    });
  });
});

describe("required argument validation", () => {
  const schema = {
    type: "object" as const,
    properties: {
      consentId: { type: "string" },
      body: {
        type: "object",
        properties: { accessToken: { type: "string" } },
        required: ["accessToken"],
      },
    },
    required: ["consentId"],
  };

  it("reports a missing path argument instead of calling the API", () => {
    assert.deepEqual(missingRequired(schema, { body: { accessToken: "t" } }), ["consentId"]);
  });

  it("reports a missing required body field", () => {
    assert.deepEqual(missingRequired(schema, { consentId: "c1", body: {} }), ["body.accessToken"]);
  });

  it("treats empty string and null as absent", () => {
    assert.deepEqual(missingRequired(schema, { consentId: "", body: { accessToken: null } }), [
      "consentId",
      "body.accessToken",
    ]);
  });

  it("passes when everything required is supplied", () => {
    assert.deepEqual(missingRequired(schema, { consentId: "c1", body: { accessToken: "t" } }), []);
  });

  it("returns nothing for a schema with no requirements", () => {
    assert.deepEqual(missingRequired({ type: "object" as const, properties: {} }, {}), []);
    assert.deepEqual(missingRequired(undefined, {}), []);
  });
});

describe("operation tool annotations", () => {
  // Clients decide what may run unattended from these hints.
  it("marks reads read-only and idempotent", () => {
    assert.deepEqual(operationAnnotations("GET"), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("marks DELETE destructive but idempotent", () => {
    const a = operationAnnotations("delete");
    assert.equal(a?.readOnlyHint, false);
    assert.equal(a?.destructiveHint, true);
    assert.equal(a?.idempotentHint, true);
  });

  it("marks POST neither read-only nor idempotent", () => {
    const a = operationAnnotations("POST");
    assert.equal(a?.readOnlyHint, false);
    assert.equal(a?.destructiveHint, false);
    assert.equal(a?.idempotentHint, false);
  });
});
