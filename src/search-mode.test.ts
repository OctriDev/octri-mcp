import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer, loadUserPermissions, SEARCH_MODE_THRESHOLD, UsageReporter } from "./core.js";

import type { CreateServerOptions, OperationTool, ToolManifest } from "./core.js";

// Search mode end to end, over the SDK's in-memory transport against a local
// upstream: the server lists four tools in place of its operations, and every
// guarantee the per-operation tools give still holds through call_tool.

function tool(
  name: string,
  method: string,
  policy: NonNullable<OperationTool["policy"]>,
  extra: Partial<OperationTool> = {},
): OperationTool {
  return {
    slug: name,
    name,
    description: `${name} description.`,
    deprecated: false,
    inputSchema: { type: "object", properties: {}, required: [] },
    http: { method, path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
    policy,
    group: "Pets",
    ...extra,
  };
}

const PET_ID = {
  type: "object" as const,
  properties: { petId: { type: "string" } },
  required: ["petId"],
};

// With listPets, deletePet and renamePet (adoptPet is off), one past the threshold.
const FILLER = Array.from({ length: SEARCH_MODE_THRESHOLD - 2 }, (_, i) =>
  tool(`listStoreItems${i}`, "GET", "auto", { description: `List store items, page ${i}.`, group: "Store" }),
);

describe("search mode", () => {
  const seen: { method: string; url: string }[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
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
        tool("listPets", "GET", "auto", { description: "List every pet in the shop." }),
        tool("deletePet", "DELETE", "confirm", {
          description: "Delete a pet by id.",
          inputSchema: PET_ID,
          http: {
            method: "DELETE",
            path: "/pets/{petId}",
            pathParams: [{ name: "petId", wireName: "petId" }],
            queryParams: [],
            bodyParams: [],
            constants: [],
          },
        }),
        tool("adoptPet", "POST", "off", { description: "Adopt a pet." }),
        tool("renamePet", "PATCH", "auto", { description: "Rename a pet." }),
        ...FILLER,
      ],
    };
  });

  after(() => {
    upstream.close();
  });

  async function connect(
    options: Partial<CreateServerOptions> & { manifest?: ToolManifest } = {},
    approval?: "accept" | "decline",
  ): Promise<{ client: Client; asked: string[] }> {
    const asked: string[] = [];
    const { manifest: own, ...rest } = options;
    const server = createServer({
      source: { kind: "static", manifest: own ?? manifest },
      env: { prefix: "ACME", vars: { ACME_API_TOKEN: "secret" } },
      ...rest,
    });
    const client = new Client(
      { name: "search-test", version: "1" },
      { capabilities: approval === undefined ? {} : { elicitation: {} } },
    );
    if (approval !== undefined) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        asked.push(request.params.message);
        return { action: approval, content: {} };
      });
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, asked };
  }

  const text = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
    (result.content as { text: string }[])[0]?.text ?? "";
  const listed = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
  const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: "call_tool", arguments: { name, arguments: args } });

  describe("which listing is served", () => {
    it("searches once the visible operations pass the threshold", async () => {
      const { client } = await connect();
      assert.deepEqual(await listed(client), ["search_tools", "describe_tool", "call_tool", "list_tool_groups"]);
      await client.close();
    });

    it("counts only what the user may see: read-only brings it under", async () => {
      const env = { prefix: "ACME", vars: { ACME_READ_ONLY: "1" } };
      const { client } = await connect({ env, permissions: loadUserPermissions([], env) });
      const names = await listed(client);
      assert.equal(names.length, SEARCH_MODE_THRESHOLD - 1);
      assert.ok(names.includes("listPets"));
      await client.close();
    });

    it("follows the owner's mode, and the user's over it", async () => {
      const ownerAll = { ...manifest, toolMode: "all" as const };
      const owner = await connect({ manifest: ownerAll });
      assert.ok((await listed(owner.client)).includes("listPets"));
      await owner.client.close();

      const user = await connect({ manifest: ownerAll, toolMode: "search" });
      assert.deepEqual((await listed(user.client)).slice(0, 3), ["search_tools", "describe_tool", "call_tool"]);
      await user.client.close();

      const small = { ...manifest, tools: manifest.tools.slice(0, 2), toolMode: "search" as const };
      const forced = await connect({ manifest: small });
      assert.ok((await listed(forced.client)).includes("call_tool"));
      await forced.client.close();
    });
  });

  describe("search_tools and describe_tool", () => {
    it("finds an operation, marks one that asks first, and never shows an off one", async () => {
      const { client } = await connect();
      const found = text(await client.callTool({ name: "search_tools", arguments: { query: "delete pet" } }));
      const first = found.split("\n")[2] ?? "";
      assert.match(first, /^deletePet · DELETE \/pets\/\{petId\} · Delete a pet by id\. · requires: petId · asks the user first$/);
      const adopt = text(await client.callTool({ name: "search_tools", arguments: { query: "adopt pet" } }));
      assert.doesNotMatch(adopt, /adoptPet/);
      await client.close();
    });

    it("leaves a denied operation out of search", async () => {
      const permissions = loadUserPermissions(["--deny-tools", "deletePet"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions });
      const found = text(await client.callTool({ name: "search_tools", arguments: { query: "delete pet" } }));
      assert.doesNotMatch(found, /deletePet/);
      await client.close();
    });

    it("describes the schema and the approval, and points an unknown name somewhere", async () => {
      const { client } = await connect();
      const described = text(
        await client.callTool({ name: "describe_tool", arguments: { names: ["deletePet", "deletePets"] } }),
      );
      assert.match(described, /## deletePet\nDELETE \/pets\/\{petId\} · group: Pets · asks the user to approve each call · can change or delete data/);
      assert.match(described, /Each call asks the user to approve it first/);
      assert.match(described, /Input schema: \{"type":"object","properties":\{"petId":\{"type":"string"\}\},"required":\["petId"\]\}/);
      assert.match(described, /## deletePets\n\nUnknown operation: deletePets\. Closest: deletePet/);
      await client.close();
    });

    it("lists the groups with their sizes", async () => {
      const { client } = await connect();
      const groups = text(await client.callTool({ name: "list_tool_groups", arguments: {} }));
      assert.match(groups, /^Pets \(3\): listPets, deletePet, renamePet$/m);
      assert.match(groups, new RegExp(`^Store \\(${FILLER.length}\\): `, "m"));
      await client.close();
    });
  });

  describe("call_tool keeps every guarantee", () => {
    it("runs an auto operation, and reports the operation's own name", async () => {
      const events: string[] = [];
      const reporter = new UsageReporter("https://api.test/api/v1", async (_url, body) => {
        events.push(body);
      });
      const { client } = await connect({
        source: { kind: "static", manifest, octri: { apiUrl: "https://api.test/api/v1", projectId: "p1", docs: false } },
        reporter,
      });
      await client.callTool({ name: "search_tools", arguments: { query: "pets" } });
      const result = await call(client, "listPets");
      assert.notEqual(result.isError, true);
      assert.deepEqual(seen.at(-1), { method: "GET", url: "/listPets" });
      await reporter.flush();
      assert.equal(events.length, 1);
      // The endpoint slug rides along since per-tool customization, so a
      // renamed tool's numbers stay with its endpoint.
      assert.match(events[0] ?? "", /"tool":"listPets","slug":"listPets","outcome":"ok"/);
      assert.doesNotMatch(events[0] ?? "", /search_tools|call_tool/);
      await client.close();
    });

    it("asks before a confirm operation, naming the operation, and sends only on yes", async () => {
      const approving = await connect({}, "accept");
      const result = await call(approving.client, "deletePet", { petId: "7" });
      assert.notEqual(result.isError, true);
      assert.match(approving.asked[0] ?? "", /^Allow deletePet to call your API\?/);
      assert.deepEqual(seen.at(-1), { method: "DELETE", url: "/pets/7" });
      await approving.client.close();

      const declining = await connect({}, "decline");
      const before = seen.length;
      const declined = await call(declining.client, "deletePet", { petId: "7" });
      assert.equal(declined.isError, true);
      assert.match(text(declined), /the user declined this call to deletePet/);
      assert.equal(seen.length, before);
      await declining.client.close();
    });

    it("refuses a confirm operation on a client that cannot ask", async () => {
      const { client } = await connect();
      const before = seen.length;
      const blocked = await call(client, "deletePet", { petId: "7" });
      assert.equal(blocked.isError, true);
      assert.match(text(blocked), /ACME_ALLOW_TOOLS=deletePet/);
      assert.equal(seen.length, before);
      await client.close();
    });

    it("lets an allow list pre-approve it, as a direct call would", async () => {
      const permissions = loadUserPermissions(["--allow-tools", "deletePet"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions });
      const result = await call(client, "deletePet", { petId: "8" });
      assert.notEqual(result.isError, true);
      assert.deepEqual(seen.at(-1), { method: "DELETE", url: "/pets/8" });
      await client.close();
    });

    it("refuses off, denied and read-only-hidden operations", async () => {
      const permissions = loadUserPermissions(["--read-only", "--deny-tools", "listPets"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions, toolMode: "search" });
      const before = seen.length;
      for (const name of ["adoptPet", "listPets", "renamePet"]) {
        const refused = await call(client, name);
        assert.equal(refused.isError, true, name);
        assert.match(text(refused), new RegExp(`^Not available: ${name} is turned off`), name);
      }
      assert.equal(seen.length, before);
      await client.close();
    });

    it("builds the request and holds it in a dry run", async () => {
      const permissions = loadUserPermissions(["--dry-run"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions });
      const before = seen.length;
      const held = await call(client, "listPets");
      assert.match(text(held), /^Dry run: this request was built but not sent\./);
      assert.equal(seen.length, before);
      await client.close();
    });

    it("hands over the schema when required arguments are missing", async () => {
      const permissions = loadUserPermissions(["--allow-tools", "*"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions });
      const result = await call(client, "deletePet");
      assert.equal(result.isError, true);
      assert.match(text(result), /missing required argument: petId\.\n\nInput schema for deletePet: \{/);
      await client.close();
    });

    it("reads arguments sent as a JSON string", async () => {
      const permissions = loadUserPermissions(["--allow-tools", "*"], { prefix: "ACME", vars: {} });
      const { client } = await connect({ permissions });
      const result = await client.callTool({
        name: "call_tool",
        arguments: { name: "deletePet", arguments: '{"petId":"9"}' },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(seen.at(-1), { method: "DELETE", url: "/pets/9" });
      await client.close();
    });

    it("suggests the nearest operation for a name it does not have", async () => {
      const { client } = await connect();
      const result = await call(client, "removePet");
      assert.equal(result.isError, true);
      assert.match(text(result), /^Unknown operation: removePet\. Closest: deletePet/);
      await client.close();
    });

    it("still runs an operation called by its own name", async () => {
      const { client } = await connect();
      const result = await client.callTool({ name: "listPets", arguments: {} });
      assert.notEqual(result.isError, true);
      await client.close();
    });
  });
});
