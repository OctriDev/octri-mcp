import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { formatDoctor, loadUserPermissions, runDoctor } from "./core.js";

import type { DoctorOptions, OperationTool, ToolManifest } from "./core.js";

// `doctor` replaces the trial and error of setting a server up in a client:
// each failure has to say what to change, and a healthy setup has to prove it
// with one real call.

function tool(name: string, method: string, policy: "auto" | "confirm", required: string[] = []): OperationTool {
  return {
    slug: name,
    name,
    description: name,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required },
    http: { method, path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy,
  };
}

describe("doctor", () => {
  let status = 200;
  const seen: (string | undefined)[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  let manifest: ToolManifest;

  before(async () => {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address !== null && typeof address !== "string");
    manifest = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      auth: "bearer",
      tools: [
        tool("deletePet", "DELETE", "confirm"),
        tool("getPet", "GET", "auto", ["petId"]),
        tool("listPets", "GET", "auto"),
      ],
    };
  });

  after(() => {
    upstream.close();
  });

  const options = (vars: Record<string, string>, extra: Partial<DoctorOptions> = {}): DoctorOptions => {
    const env = { prefix: "ACME", vars };
    return {
      source: { kind: "static", manifest },
      env,
      permissions: loadUserPermissions([], env),
      telemetry: true,
      ...extra,
    };
  };
  const byName = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
    checks.find((c) => c.name === name);

  it("passes a healthy setup with one real read that needs no arguments", async () => {
    status = 200;
    const checks = await runDoctor(options({ ACME_API_TOKEN: "tok" }));
    assert.equal(checks.filter((c) => c.status === "fail").length, 0);
    assert.match(byName(checks, "Operation tools")?.detail ?? "", /3 offered, 1 ask the user/);
    assert.deepEqual(byName(checks, "Test call"), { status: "pass", name: "Test call", detail: "listPets: 200" });
    assert.equal(seen.at(-1), "Bearer tok");
    assert.match(formatDoctor(checks), /^Ready\./m);
  });

  it("names the missing credential variable and makes no call without it", async () => {
    const before = seen.length;
    const checks = await runDoctor(options({}));
    assert.deepEqual(byName(checks, "Credentials"), {
      status: "fail",
      name: "Credentials",
      detail: "bearer auth: set ACME_API_TOKEN.",
    });
    assert.equal(byName(checks, "Test call")?.status, "info");
    assert.equal(seen.length, before);
    assert.match(formatDoctor(checks), /1 check failed\./);
  });

  it("blames the credentials when the API refuses them", async () => {
    status = 401;
    const checks = await runDoctor(options({ ACME_API_TOKEN: "wrong" }));
    assert.equal(byName(checks, "Test call")?.status, "fail");
    assert.match(byName(checks, "Test call")?.detail ?? "", /401\. The API refused the credentials\. Check ACME_API_TOKEN/);
    status = 200;
  });

  it("skips the call when asked, or in dry-run mode", async () => {
    const before = seen.length;
    const skipped = await runDoctor(options({ ACME_API_TOKEN: "tok" }, { call: false }));
    assert.equal(byName(skipped, "Test call")?.detail, "Skipped (--no-call).");
    const env = { prefix: "ACME", vars: { ACME_API_TOKEN: "tok", ACME_DRY_RUN: "1" } };
    const dry = await runDoctor(options(env.vars, { permissions: loadUserPermissions([], env) }));
    assert.match(byName(dry, "Test call")?.detail ?? "", /dry-run/);
    assert.equal(seen.length, before);
  });

  it("says where to set the project when a live server has none", async () => {
    const checks = await runDoctor({
      ...options({}),
      source: { kind: "live", apiUrl: "http://127.0.0.1:9/api/v1", projectId: "" },
    });
    assert.deepEqual(checks, [
      { status: "fail", name: "Project", detail: "No project set. Pass --project-id or set ACME_PROJECT_ID." },
    ]);
  });
});
