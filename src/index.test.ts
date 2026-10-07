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
  serializeRequestBody,
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

  it("keeps root object fields while injecting body constants without bindings", () => {
    const rootObject: HttpMapping = {
      ...http,
      bodyParams: [],
      constants: [{ location: "body", wireName: "kind", value: "fixture" }],
    };
    assert.deepEqual(JSON.parse(buildRequestBody(rootObject, { body: { name: "Ada" } }, "POST") ?? "null"), {
      name: "Ada",
      kind: "fixture",
    });
  });
});

describe("persisted operation media serializers", () => {
  const base: HttpMapping = {
    method: "POST", path: "/upload", pathParams: [], queryParams: [], bodyParams: [], constants: [],
  };

  it("keeps nested form arrays on bracketed wire keys", () => {
    const encoded = serializeRequestBody(
      { ...base, requestBody: { contentType: "application/x-www-form-urlencoded" } },
      { body: { customer: { name: "Ada" }, tags: ["a", "b"] } },
      "POST",
    );
    assert.equal(encoded.contentType, "application/x-www-form-urlencoded");
    assert.equal(encoded.body, "customer%5Bname%5D=Ada&tags%5B%5D=a&tags%5B%5D=b");
  });

  it("honors explicit form repeated, CSV, and flat-object encodings", () => {
    const encoded = serializeRequestBody(
      {
        ...base,
        requestBody: {
          contentType: "application/x-www-form-urlencoded",
          encoding: {
            repeated: { style: "form", explode: true },
            csv: { style: "form", explode: false },
            labels: { style: "form", explode: true },
            compact: { style: "form", explode: false },
          },
        },
      },
      { body: { repeated: ["a", "b"], csv: ["c", "d"], labels: { role: "admin", scope: "all" }, compact: { R: 100, G: 200 } } },
      "POST",
    );
    const form = new URLSearchParams(encoded.body as string);
    assert.deepEqual(form.getAll("repeated"), ["a", "b"]);
    assert.equal(form.get("csv"), "c,d");
    assert.equal(form.get("role"), "admin");
    assert.equal(form.get("scope"), "all");
    assert.equal(form.get("compact"), "R,100,G,200");
  });

  it("refuses urlencoded directives this MCP boundary cannot serialize", () => {
    const configured = (encoding: Record<string, unknown>) => serializeRequestBody(
      { ...base, requestBody: { contentType: "application/x-www-form-urlencoded", encoding: { field: encoding } } },
      { body: { field: "value" } },
      "POST",
    );
    assert.throws(() => configured({ style: "deepObject" }), /Unsupported form encoding style/);
    assert.throws(() => configured({ headers: { "X-Part": { schema: { type: "string" } } } }), /form part headers/);
  });

  it("uses multipart boundaries and inline base64 files without filesystem inputs", () => {
    const encoded = serializeRequestBody(
      { ...base, requestBody: { contentType: "multipart/form-data", schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } },
      { body: { file: { filename: "note.txt", content: Buffer.from("hello").toString("base64"), contentType: "text/plain" } } },
      "POST",
    );
    assert.equal(encoded.contentType, undefined);
    assert.ok(encoded.body instanceof FormData);
  });

  it("keeps ordinary multipart filename/content objects as JSON data", async () => {
    const encoded = serializeRequestBody(
      { ...base, requestBody: { contentType: "multipart/form-data" } },
      { body: { metadata: { filename: "display-name", content: "plain-text" } } },
      "POST",
    );
    assert.ok(encoded.body instanceof FormData);
    const part = encoded.body.get("metadata");
    assert.ok(part instanceof Blob);
    assert.equal(part.type, "application/json");
    assert.deepEqual(JSON.parse(await part.text()), { filename: "display-name", content: "plain-text" });
  });

  it("keeps JSON Patch, text, and binary root bodies in their documented media", () => {
    assert.equal(
      serializeRequestBody({ ...base, requestBody: { contentType: "application/json-patch+json" } }, { body: [{ op: "replace" }] }, "PATCH").contentType,
      "application/json-patch+json",
    );
    assert.equal(
      serializeRequestBody({ ...base, requestBody: { contentType: "text/plain" } }, { body: "raw" }, "POST").body,
      "raw",
    );
    const binary = serializeRequestBody(
      { ...base, requestBody: { contentType: "application/octet-stream" } },
      { body: { filename: "x.bin", content: "AAE=" } },
      "POST",
    );
    assert.equal(binary.contentType, "application/octet-stream");
    assert.deepEqual(Buffer.from(binary.body as Uint8Array), Buffer.from([0, 1]));
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

  it("checks child requirements only when optional root body is supplied", () => {
    const optionalRoot = {
      type: "object" as const,
      properties: {
        body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    };
    assert.deepEqual(missingRequired(optionalRoot, {}), []);
    assert.deepEqual(missingRequired(optionalRoot, { body: {} }), ["body.name"]);
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
