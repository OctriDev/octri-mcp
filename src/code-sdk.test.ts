import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pythonProgram, typeScriptProgram } from "./code-mode.js";
import { methodTable, pyType, sdkMethods, signature, snakeCase, tsType, type CodeModeManifest } from "./code-sdk.js";

import type { OperationTool } from "./operations.js";

// The SDK surface a code mode script sees: call paths, keyword names, and the
// signatures describe_sdk prints.

function op(name: string, properties: Record<string, object> = {}, required: string[] = []): OperationTool {
  return {
    slug: `slug-${name}`,
    name,
    description: `${name} does a thing.\nMore detail.`,
    deprecated: false,
    inputSchema: { type: "object", properties, required },
    http: { method: "GET", path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
  };
}

describe("code mode SDK surface", () => {
  it("uses the published call path, and falls back to the tool name where it cannot", () => {
    const tools = [op("listPets"), op("getPet"), op("weird"), op("clash")];
    const manifest: CodeModeManifest = {
      languages: ["typescript", "python"],
      methods: {
        listPets: { typescript: "pets.list", python: "pets.list" },
        getPet: { typescript: "pets.get", python: "pets.get" },
        // A numeric path segment is no identifier in either language.
        weird: { typescript: "0.pet", python: "0.pet" },
        // Two operations on one path: the second gets its own name.
        clash: { typescript: "pets.list", python: "pets.list" },
      },
    };
    assert.deepEqual(sdkMethods(tools, manifest, "typescript").map((m) => m.path), ["pets.list", "pets.get", "weird", "clash"]);
    assert.deepEqual(sdkMethods(tools, manifest, "python").map((m) => m.path), ["pets.list", "pets.get", "weird", "clash"]);
  });

  it("refuses Python keywords as path segments", () => {
    const tools = [op("importThings")];
    const manifest: CodeModeManifest = { languages: ["python"], methods: { importThings: { typescript: "import.run", python: "import.run" } } };
    assert.deepEqual(sdkMethods(tools, manifest, "python").map((m) => m.path), ["import_things"]);
  });

  it("names Python keywords the way the generated SDK does, and maps them back", () => {
    assert.equal(snakeCase("petId"), "pet_id");
    assert.equal(snakeCase("HTTPStatus"), "http_status");
    assert.equal(snakeCase("x-request-id"), "x_request_id");
    const [method] = sdkMethods(
      [op("getPet", { petId: { type: "string" }, pet_id: { type: "string" }, from: { type: "string" }, limit: { type: "integer" } })],
      { languages: ["python"], methods: { getPet: { typescript: "pets.get", python: "pets.get" } } },
      "python",
    );
    // `pet_id` is already taken by another argument, `from` is a keyword: both stay as they are.
    assert.deepEqual(method?.params, undefined);
    const [mapped] = sdkMethods(
      [op("getPet", { petId: { type: "string" }, "x-trace": { type: "string" } })],
      { languages: ["python"], methods: { getPet: { typescript: "pets.get", python: "pets.get" } } },
      "python",
    );
    assert.deepEqual(mapped?.params, { pet_id: "petId", x_trace: "x-trace" });
    assert.deepEqual(methodTable([mapped!]), { "pets.get": { tool: "getPet", params: { pet_id: "petId", x_trace: "x-trace" } } });
  });

  it("renders bounded types in both languages", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        owner: { oneOf: [{ type: "null" }, { type: "object", properties: { name: { type: "string" } } }] },
        "odd-key": { type: "integer" },
      },
    };
    assert.equal(tsType(schema), '{ id: string; tags?: Array<"a" | "b">; owner?: null | { name?: string }; "odd-key"?: number }');
    assert.equal(pyType(schema), 'dict{id: str, tags?: list[Literal["a", "b"]], owner?: None | dict{name?: str}, odd-key?: int}');
    // Deep nesting turns into the unknown type rather than an unreadable wall.
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i++) deep = { type: "object", properties: { next: deep } };
    assert.match(tsType(deep), /unknown/);
  });

  it("prints a signature with the first line of the description and the approval note", () => {
    const [method] = sdkMethods(
      [op("getPet", { petId: { type: "string" } }, ["petId"])],
      { languages: ["typescript"], methods: { getPet: { typescript: "pets.get", python: "pets.get", returns: { type: "object", properties: { id: { type: "string" } } } } } },
      "typescript",
    );
    assert.equal(
      signature(method!, "typescript", true),
      "/** getPet does a thing. GET /getPet Asks the user to approve each call. */\nclient.pets.get(args: { petId: string }): Promise<{ id?: string }>",
    );
  });

  it("puts the script after the preamble, and counts its lines exactly", () => {
    const script = "const a = 1;\nreturn a;";
    const ts = typeScriptProgram([], script);
    assert.deepEqual(ts.source.split("\n").slice(ts.lineOffset, ts.lineOffset + ts.lineCount), ["const a = 1;", "return a;"]);
    const py = pythonProgram([], "a = 1\n\nreturn a\n");
    assert.deepEqual(py.source.split("\n").slice(py.lineOffset, py.lineOffset + py.lineCount), ["    a = 1", "", "    return a"]);
    assert.equal(pythonProgram([], "   \n").source.split("\n")[pythonProgram([], "").lineOffset], "    pass");
  });
});
