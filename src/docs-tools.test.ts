import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatEndpoint, formatNav, formatSdkMethodIndex, type NavResponse } from "./docs-tools.js";

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
