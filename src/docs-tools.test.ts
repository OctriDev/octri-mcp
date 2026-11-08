import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatChangelog,
  formatEndpoint,
  formatNav,
  formatSdkMethodIndex,
  formatSearchResults,
  htmlToText,
  type NavResponse,
} from "./docs-tools.js";

const guide = (slug: string, groupSlug: string) => ({ slug, title: slug, type: "guide", groupSlug });
const endpoint = (n: number) => ({ slug: `get-things-${n}`, title: `Thing ${n}`, type: "endpoint", method: "GET", path: `/things/${n}` });

describe("list_endpoints", () => {
  // A tabbed site's top-level `sections` is only its first tab, which held the
  // guides: every showcase listed 0 of its endpoints.
  it("lists the endpoints of every tab, not only the first", () => {
    const nav: NavResponse = {
      sections: [{ title: "Get started", items: [guide("quickstart", "get-started")] }],
      tabs: [
        { label: "Overview", sections: [{ title: "Get started", items: [guide("quickstart", "get-started")] }] },
        { label: "API Reference", sections: [{ title: "Domains", items: [endpoint(1), endpoint(2)] }] },
      ],
    };
    const text = formatNav(nav, undefined);
    assert.match(text, /## API Reference/);
    assert.match(text, /`GET \/things\/1` \(slug: `get-things-1`\)/);
    assert.match(text, /\(guide, slug: `quickstart`, groupSlug: `get-started`\)/);
  });

  it("gives a link its URL, not a slug no tool can read", () => {
    const nav: NavResponse = {
      sections: [{ title: "Resources", items: [{ slug: "https://example.com/docs", title: "Vendor docs", type: "link" }] }],
    };
    assert.equal(formatNav(nav, undefined), "### Resources\n  - **Vendor docs**: https://example.com/docs");
  });

  it("lists a large API's sections with counts, and one section in full", () => {
    const items = Array.from({ length: 200 }, (_, i) => endpoint(i));
    const nav: NavResponse = {
      sections: [],
      tabs: [{ label: "API Reference", sections: [{ title: "Things", items }, { title: "Other", items: [endpoint(999)] }] }],
    };
    const compact = formatNav(nav, undefined);
    assert.match(compact, /^201 endpoints, too many to list at once/);
    assert.match(compact, /### Things\n {2}- 200 endpoints/);
    assert.doesNotMatch(compact, /get-things-5`/);
    const one = formatNav(nav, "things");
    assert.equal((one.match(/`GET /g) ?? []).length, 200);
  });
});

describe("get_endpoint", () => {
  it("prints the documentation the page route nests under content", () => {
    const text = formatEndpoint({
      project: { name: "Resend" },
      spec: { version: "1.5.1" },
      page: {
        slug: "get-domains",
        title: "List domains",
        method: "GET",
        path: "/domains",
        content: {
          description: "Lists domains in the account.",
          parameters: [{ name: "limit", in: "query", required: false, description: "Between 1 and 100." }],
          responses: { "200": { description: "A list of domains." } },
          codeExamples: [{ language: "curl", code: "curl https://api.resend.com/domains" }],
        },
      },
    });
    assert.match(text, /Lists domains in the account\./);
    assert.match(text, /- \*\*limit\*\* \(query\): Between 1 and 100\./);
    assert.match(text, /- \*\*200\*\*: A list of domains\./);
    assert.match(text, /```curl\ncurl https:\/\/api\.resend\.com\/domains\n```/);
  });
});

describe("get_sdk_methods without a slug", () => {
  it("lists one line per endpoint and no code", () => {
    const text = formatSdkMethodIndex({
      languages: ["typescript"],
      endpoints: [
        { slug: "get-domains", title: "List domains", method: "GET", path: "/domains", methodName: "domainsList", snippets: { typescript: "client.domains.list()" } },
      ],
    });
    assert.match(text, /^- \*\*List domains\*\* `GET \/domains` \(slug: `get-domains`\)/);
    assert.doesNotMatch(text, /client\.domains/);
    assert.doesNotMatch(text, /domainsList/);
  });
});

const meta = { project: { name: "Acme API" }, spec: { version: "2024-08-01" } };

describe("formatEndpoint", () => {
  it("reads the documentation the public pages route nests under content", () => {
    const text = formatEndpoint({
      ...meta,
      page: {
        slug: "post-customers",
        title: "Create a customer",
        method: "POST",
        path: "/customers",
        content: {
          description: "Creates a customer you can bill.",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, description: "Makes a retry safe." }],
          requestBody: {
            contentType: "application/json",
            fields: [
              { name: "name", type: "string", description: "", required: true },
              { name: "email", type: "string", description: "Where invoices go.", required: true },
            ],
          },
          responses: { "201": { description: "The customer that was created." } },
          codeExamples: [{ language: "curl", code: "curl -X POST https://api.acme.com/v1/customers" }],
        },
      },
    });
    assert.match(text, /^Creates a customer you can bill\.$/m);
    assert.match(text, /^- \*\*Idempotency-Key\*\* \(header\): Makes a retry safe\.$/m);
    assert.match(text, /^## Request body \(application\/json\)$/m);
    // An empty description adds no dangling colon.
    assert.match(text, /^- \*\*name\*\* \(string\) \*\(required\)\*$/m);
    assert.match(text, /^- \*\*email\*\* \(string\) \*\(required\)\*: Where invoices go\.$/m);
    assert.match(text, /^- \*\*201\*\*: The customer that was created\.$/m);
    assert.match(text, /curl -X POST https:\/\/api\.acme\.com\/v1\/customers/);
  });

  it("still reads the same fields at the top of the page", () => {
    const text = formatEndpoint({
      ...meta,
      page: {
        slug: "get-customers",
        title: "List customers",
        description: "Every customer, newest first.",
        responses: { "200": { description: "A page of customers." } },
      },
    });
    assert.match(text, /^Every customer, newest first\.$/m);
    assert.match(text, /^- \*\*200\*\*: A page of customers\.$/m);
  });

  it("leaves out a description that only repeats the title, and marks a deprecated endpoint", () => {
    const text = formatEndpoint({
      ...meta,
      page: {
        slug: "get-legacy",
        title: "Legacy report",
        content: { description: "Legacy report", deprecated: true, deprecationNote: "Use the usage report." },
      },
    });
    assert.equal(text.match(/Legacy report/g)?.length, 1);
    assert.match(text, /^\*\*Deprecated\.\*\* Use the usage report\.$/m);
  });
});

describe("formatChangelog", () => {
  const entry = {
    id: "c1",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    hasBreakingChanges: true,
    generatedAt: "2026-10-07T17:39:36.113Z",
  };

  it("lists what changed from the entry's diff when it has no markdown", () => {
    const diffRaw = JSON.stringify({
      endpoints: [
        { method: "POST", path: "/customers", status: "added", changes: [] },
        {
          method: "GET",
          path: "/invoices",
          status: "changed",
          changes: [
            { description: "Query parameter `status` was removed", breaking: "breaking" },
            { description: "Response field `total` was added", breaking: "non_breaking" },
          ],
        },
        { method: "GET", path: "/events", status: "unchanged", changes: [] },
      ],
    });
    const text = formatChangelog([{ ...entry, markdown: null, summary: null, diffRaw }], false);
    assert.match(text, /^- \*\*POST \/customers\*\* added$/m);
    assert.match(text, /^- \*\*GET \/invoices\*\* changed$/m);
    assert.match(text, /^ {2}- Query parameter `status` was removed \(breaking\)$/m);
    assert.match(text, /^ {2}- Response field `total` was added$/m);
    assert.doesNotMatch(text, /\/events/);
  });

  it("prefers the entry's markdown, and keeps the heading when the diff can't be read", () => {
    assert.match(formatChangelog([{ ...entry, markdown: "Written notes.", diffRaw: "{}" }], false), /Written notes\./);
    const bare = formatChangelog([{ ...entry, diffRaw: "not json" }], false);
    assert.match(bare, /^## 1\.0\.0 → 1\.1\.0 \(\*\*Breaking changes\*\*\)$/m);
  });
});

describe("reading a guide found by search_docs or list_endpoints", () => {
  it("prints a guide's groupSlug, which get_guide needs to find it", () => {
    const text = formatSearchResults([
      { slug: "tool-groups", title: "Tool groups", type: "guide", groupSlug: "mcp" },
      { slug: "get-users", title: "List users", type: "endpoint", method: "GET", path: "/users" },
    ]);
    assert.match(text, /^1\. \*\*Tool groups\*\* \(guide\)\n {3}Slug: `tool-groups`, groupSlug: `mcp`$/m);
    assert.match(text, /^2\. \*\*List users\*\* `GET \/users`\n {3}Slug: `get-users`$/m);
  });

  it("lists a guide's groupSlug beside its slug, and an endpoint as before", () => {
    const text = formatNav(
      {
        sections: [
          {
            title: "Guides",
            items: [
              { slug: "quickstart", title: "Quickstart", type: "guide", groupSlug: "start" },
              { slug: "get-users", title: "List users", method: "GET", path: "/users" },
            ],
          },
        ],
      },
      undefined,
    );
    assert.match(text, /^ {2}- \*\*Quickstart\*\* \(guide, slug: `quickstart`, groupSlug: `start`\)$/m);
    assert.match(text, /^ {2}- \*\*List users\*\* `GET \/users` \(slug: `get-users`\)$/m);
  });

  it("keeps a guide's headings and bullets when it turns the page into text", () => {
    const text = htmlToText("<h2 id=\"setup\">Setup</h2><p>Install it.</p><ul><li>One</li><li>Two</li></ul><h3>Next</h3>");
    assert.equal(text, "## Setup\nInstall it.\n\n- One\n- Two\n\n### Next");
  });
});
