import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveOperationUrl, httpRequestRefusal } from "./index.js";

describe("operation URL resolution", () => {
  const base = "https://api.example.test";

  it("keeps a normal path on the configured origin", () => {
    const url = resolveOperationUrl(base, "/v1/users/42", "limit=5");
    assert.equal(url.toString(), "https://api.example.test/v1/users/42?limit=5");
  });

  it("refuses a stored path that re-points the URL via userinfo", () => {
    assert.throws(
      () => resolveOperationUrl(base, "@evil.test/v1/users", ""),
      /leaves the configured base URL/,
    );
  });

  it("refuses a non-HTTP base URL", () => {
    assert.throws(
      () => resolveOperationUrl("file:///etc", "/passwd", ""),
      /unsupported base URL scheme/,
    );
  });
});

describe("HTTP transport guard", () => {
  const loopback = { host: "127.0.0.1", allowedOrigins: new Set<string>() };

  it("allows a non-browser request to the loopback interface", () => {
    assert.equal(httpRequestRefusal({ host: "127.0.0.1:3000" }, loopback), null);
  });

  it("refuses a request carrying an unlisted browser origin", () => {
    const refusal = httpRequestRefusal(
      { host: "localhost:3000", origin: "https://evil.test" },
      loopback,
    );
    assert.match(refusal ?? "", /Origin https:\/\/evil\.test is not allowed/);
  });

  it("allows an origin the operator listed", () => {
    assert.equal(
      httpRequestRefusal(
        { host: "localhost:3000", origin: "https://app.example.test" },
        { host: "127.0.0.1", allowedOrigins: new Set(["https://app.example.test"]) },
      ),
      null,
    );
  });

  it("treats the IPv6 loopback as local, bare or bracketed", () => {
    assert.equal(
      httpRequestRefusal({ host: "[::1]:3000" }, { host: "::1", allowedOrigins: new Set<string>() }),
      null,
    );
    assert.match(
      httpRequestRefusal({ host: "attacker.test" }, { host: "::1", allowedOrigins: new Set<string>() }) ?? "",
      /not the loopback interface/,
    );
  });

  it("refuses a rebound host while bound to loopback", () => {
    const refusal = httpRequestRefusal({ host: "attacker.test" }, loopback);
    assert.match(refusal ?? "", /not the loopback interface/);
  });

  it("leaves the host check to the operator once MCP_HOST is widened", () => {
    assert.equal(
      httpRequestRefusal(
        { host: "mcp.internal:3000" },
        { host: "0.0.0.0", allowedOrigins: new Set<string>() },
      ),
      null,
    );
  });
});
