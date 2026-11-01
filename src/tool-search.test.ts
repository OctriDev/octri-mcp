import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildToolIndex,
  loadConfig,
  parseToolMode,
  resolveToolMode,
  SEARCH_MODE_THRESHOLD,
  searchModeTools,
  searchTools,
} from "./core.js";
import { searchTerms, summaryLine } from "./tool-search.js";

import type { OperationTool } from "./core.js";

// Search mode's pure half: which listing a server serves, how a query ranks
// the operations, and what the four tools say about themselves.

function op(name: string, method: string, path: string, description: string, extra: Partial<OperationTool> = {}): OperationTool {
  return {
    slug: `${method.toLowerCase()}-${path}`,
    name,
    description,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    ...extra,
  };
}

// A slice of GitHub: "repos" sits on most paths, so it should say little.
const GITHUB: OperationTool[] = [
  op("reposGet", "GET", "/repos/{owner}/{repo}", "Get a repository.", { group: "Repos" }),
  op("reposCreateFork", "POST", "/repos/{owner}/{repo}/forks", "Create a fork.\n\nCreate a fork for the authenticated user.", { group: "Repos" }),
  op("reposDelete", "DELETE", "/repos/{owner}/{repo}", "Delete a repository.", { group: "Repos" }),
  op("issuesCreate", "POST", "/repos/{owner}/{repo}/issues", "Create an issue.\n\nAny user with pull access to a repository can create an issue.", { group: "Issues" }),
  op("issuesListForRepo", "GET", "/repos/{owner}/{repo}/issues", "List repository issues.", { group: "Issues" }),
  op("issuesUpdate", "PATCH", "/repos/{owner}/{repo}/issues/{issue_number}", "Update an issue.", { group: "Issues" }),
  op("pullsList", "GET", "/repos/{owner}/{repo}/pulls", "List pull requests.", { group: "Pulls" }),
  op("pullsMerge", "PUT", "/repos/{owner}/{repo}/pulls/{pull_number}/merge", "Merge a pull request.", { group: "Pulls" }),
  op("teamsListMembersInOrg", "GET", "/orgs/{org}/teams/{team_slug}/members", "List team members.", { group: "Teams / Members" }),
  op("reposListForks", "GET", "/repos/{owner}/{repo}/forks", "[Deprecated] List forks.", { group: "Repos", deprecated: true }),
];

const names = (tools: readonly OperationTool[]) => tools.map((t) => t.name);

describe("tool mode", () => {
  it("reads a mode, and refuses one it does not know", () => {
    assert.equal(parseToolMode(undefined), undefined);
    assert.equal(parseToolMode(" Search "), "search");
    // Code mode is a fourth listing, so the refusal names it too.
    assert.throws(() => parseToolMode("dynamic"), /Use all, search, code or auto/);
    assert.equal(parseToolMode("CODE"), "code");
  });

  it("serves code mode only where it is available, and never picks it automatically", () => {
    assert.equal(resolveToolMode(undefined, "code", 2, true), "code");
    assert.equal(resolveToolMode("code", "all", 2, true), "code");
    // Asked for, but not published or not runnable here: search, not one tool per operation.
    assert.equal(resolveToolMode(undefined, "code", 2, false), "search");
    assert.equal(resolveToolMode("code", undefined, 2), "search");
    assert.equal(resolveToolMode(undefined, undefined, 5_000, true), "search");
    assert.equal(resolveToolMode("all", "code", 2, true), "all");
  });

  it("lets the user override the owner, and the owner override the threshold", () => {
    assert.equal(resolveToolMode(undefined, undefined, SEARCH_MODE_THRESHOLD), "all");
    assert.equal(resolveToolMode(undefined, undefined, SEARCH_MODE_THRESHOLD + 1), "search");
    assert.equal(resolveToolMode(undefined, "all", 5_000), "all");
    assert.equal(resolveToolMode(undefined, "search", 2), "search");
    assert.equal(resolveToolMode("all", "search", 5_000), "all");
    assert.equal(resolveToolMode("search", "all", 2), "search");
    // A user's explicit auto means the threshold, whatever the owner chose.
    assert.equal(resolveToolMode("auto", "search", 2), "all");
  });

  it("uses the owner's threshold for auto, and the default for a bad one", () => {
    assert.equal(resolveToolMode(undefined, undefined, 11, false, 10), "search");
    assert.equal(resolveToolMode(undefined, undefined, 10, false, 10), "all");
    assert.equal(resolveToolMode(undefined, undefined, 100, false, 200), "all");
    // The threshold only decides auto: an explicit mode wins over it.
    assert.equal(resolveToolMode(undefined, "all", 11, false, 10), "all");
    // A manifest from somewhere else with a nonsense value keeps the default.
    assert.equal(resolveToolMode(undefined, undefined, SEARCH_MODE_THRESHOLD + 1, false, 0), "search");
    assert.equal(resolveToolMode(undefined, undefined, SEARCH_MODE_THRESHOLD, false, 2.5), "all");
  });

  it("reads --tool-mode in both spellings, and the prefixed variable", () => {
    const env = { prefix: "ACME", vars: { ACME_TOOL_MODE: "all" } };
    assert.equal(loadConfig([], env).toolMode, "all");
    assert.equal(loadConfig(["--tool-mode=search"], env).toolMode, "search");
    assert.equal(loadConfig(["--tool-mode", "auto"], env).toolMode, "auto");
    assert.equal("toolMode" in loadConfig([], { prefix: "ACME", vars: {} }), false);
  });
});

describe("search ranking", () => {
  const index = buildToolIndex(GITHUB);
  const search = (query: string, options = {}) => names(searchTools(index, query, options).matches);

  it("splits names and paths into words, and folds plurals", () => {
    assert.deepEqual(searchTerms("teamsListMembersInOrg"), ["team", "list", "member", "org"]);
    assert.deepEqual(searchTerms("/repos/{owner}/pull_requests"), ["repo", "owner", "pull", "request"]);
  });

  it("folds the long words APIs shorten, so prose finds abbreviated names", () => {
    assert.deepEqual(searchTerms("Repositories of an organization"), ["repo", "org"]);
    assert.equal(names(searchTools(index, "get repository").matches)[0], "reposGet");
  });

  it("prefers a short name that is exactly the query over a longer one containing it", () => {
    const tools = [
      op("orgsCreateIssueField", "POST", "/orgs/{org}/issue-fields", "Create issue field for an organization."),
      op("issuesCreate", "POST", "/repos/{owner}/{repo}/issues", "Create an issue."),
    ];
    assert.equal(names(searchTools(buildToolIndex(tools), "create an issue").matches)[0], "issuesCreate");
  });

  it("puts the operation that does what was asked first", () => {
    assert.equal(search("create issue")[0], "issuesCreate");
    assert.equal(search("merge a pull request")[0], "pullsMerge");
    assert.equal(search("members of a team")[0], "teamsListMembersInOrg");
  });

  it("lets the verb pick between operations on the same thing", () => {
    assert.equal(search("update issue")[0], "issuesUpdate");
    assert.equal(search("list issues")[0], "issuesListForRepo");
    assert.equal(search("delete repository")[0], "reposDelete");
  });

  it("weighs a rare word over one most operations share", () => {
    assert.equal(search("repo fork")[0], "reposCreateFork");
  });

  it("sinks deprecated operations below current ones", () => {
    const forks = search("forks");
    assert.ok(forks.indexOf("reposCreateFork") < forks.indexOf("reposListForks"));
  });

  it("finds an operation by its exact name", () => {
    assert.equal(search("pullsMerge")[0], "pullsMerge");
  });

  it("browses a group, a parent taking in its subfolders", () => {
    assert.deepEqual(search("", { group: "issues" }), ["issuesCreate", "issuesListForRepo", "issuesUpdate"]);
    assert.deepEqual(search("", { group: "Teams" }), ["teamsListMembersInOrg"]);
    assert.deepEqual(search("list", { group: "Pulls" }), ["pullsList"]);
  });

  it("pages, and caps the page size", () => {
    const all = searchTools(index, "repository");
    const second = searchTools(index, "repository", { limit: 1, offset: 1 });
    assert.equal(second.total, all.total);
    assert.deepEqual(names(second.matches), names(all.matches).slice(1, 2));
    assert.equal(searchTools(index, "", { group: "Repos", limit: 1_000 }).matches.length, 4);
  });

  it("returns nothing for words no operation has", () => {
    assert.equal(searchTools(index, "kubernetes").total, 0);
  });
});

describe("search mode tools", () => {
  it("lists the three tools, and groups only when there are some", () => {
    assert.deepEqual(
      searchModeTools(GITHUB).map((t) => t.name),
      ["search_tools", "describe_tool", "call_tool", "list_tool_groups"],
    );
    const ungrouped = GITHUB.map(({ group: _group, ...rest }) => rest);
    const tools = searchModeTools(ungrouped);
    assert.deepEqual(tools.map((t) => t.name), ["search_tools", "describe_tool", "call_tool"]);
    assert.equal("group" in (tools[0]?.inputSchema.properties ?? {}), false);
  });

  it("says how many operations stand behind search", () => {
    assert.match(searchModeTools(GITHUB)[0]?.description ?? "", /It has 10 operations/);
  });

  it("marks call_tool read-only when every visible operation reads", () => {
    const reads = GITHUB.filter((t) => t.http.method === "GET");
    const call = (tools: OperationTool[]) => searchModeTools(tools).find((t) => t.name === "call_tool");
    assert.equal(call(reads)?.annotations?.readOnlyHint, true);
    assert.equal(call(reads)?.annotations?.destructiveHint, false);
    assert.equal(call(GITHUB)?.annotations?.destructiveHint, true);
  });

  it("summarizes a description by its first sentence", () => {
    assert.equal(summaryLine("Create an issue.\n\nAny user can."), "Create an issue.");
    assert.equal(summaryLine("[Deprecated] List forks."), "List forks.");
    assert.equal(summaryLine("x".repeat(300)).length, 160);
  });
});
