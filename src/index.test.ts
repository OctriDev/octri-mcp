import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatChangelog } from "./index.js";

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
