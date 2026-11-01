import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateFromSchema,
  mergeAllOf,
  PRACTICE_MAX_CHARS,
  PRACTICE_MAX_DEPTH,
  practiceRandom,
  seedFrom,
  stringForPattern,
  type JsonSchema,
} from "./practice-schema.js";

// Practice values from a JSON Schema: every keyword the generator reads,
// determinism, recursion and the size cap.

const gen = (schema: JsonSchema, seed = 7, mode?: "response" | "request") =>
  generateFromSchema(schema, seed, mode !== undefined ? { mode } : {});

describe("practice schema generator", () => {
  it("is deterministic per seed, and differs across seeds", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, count: { type: "integer" } },
    };
    assert.deepEqual(gen(schema, 1), gen(schema, 1));
    assert.notDeepEqual(gen(schema, 1), gen(schema, 2));
    assert.equal(seedFrom("a", "bc"), seedFrom("a", "bc"));
    assert.notEqual(seedFrom("ab", "c"), seedFrom("a", "bc"));
  });

  it("adding a field never reshuffles its siblings", () => {
    const one = gen({ type: "object", properties: { email: { type: "string" } } }) as Record<string, unknown>;
    const two = gen({ type: "object", properties: { email: { type: "string" }, zzz: { type: "string" } } }) as Record<string, unknown>;
    assert.equal(one["email"], two["email"]);
  });

  it("documented words win: const, example, examples, enum, default", () => {
    assert.equal(gen({ type: "string", const: "fixed" }), "fixed");
    assert.equal(gen({ type: "string", example: "ex" }), "ex");
    assert.equal(gen({ type: "integer", examples: [42, 7] }), 42);
    assert.ok(["a", "b"].includes(gen({ type: "string", enum: ["a", "b", null] }) as string));
    assert.equal(gen({ type: "string", default: "dflt" }), "dflt");
  });

  it("formats", () => {
    const value = (format: string) => gen({ type: "string", format }) as string;
    assert.match(value("date-time"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(value("date"), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(value("time"), /^\d{2}:\d{2}:\d{2}$/);
    assert.match(value("email"), /^[a-z]+\.[a-z]+@example\.com$/);
    assert.match(value("uri"), /^https:\/\/example\.com\//);
    assert.match(value("uuid"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(value("ipv4"), /^192\.0\.2\.\d+$/);
    assert.match(value("ipv6"), /^2001:db8::/);
    assert.match(value("hostname"), /\.example\.com$/);
    assert.equal(value("byte"), "cHJhY3RpY2UgbW9kZQ==");
  });

  it("timestamps never move with the clock", () => {
    const year = (gen({ type: "string", format: "date-time" }) as string).slice(0, 4);
    assert.ok(year === "2025" || year === "2026");
  });

  it("field names make values believable", () => {
    const value = gen({
      type: "object",
      properties: {
        email: { type: "string" },
        first_name: { type: "string" },
        created_at: { type: "string" },
        website_url: { type: "string" },
        user_id: { type: "string" },
        price: { type: "number" },
      },
    }) as Record<string, unknown>;
    assert.match(value["email"] as string, /@example\.com$/);
    assert.match(value["first_name"] as string, /^[A-Z][a-z]+$/);
    assert.match(value["created_at"] as string, /T.*Z$/);
    assert.match(value["website_url"] as string, /^https:/);
    assert.match(value["user_id"] as string, /^use_[0-9a-f]{12}$/);
    assert.ok((value["price"] as number) >= 5 && (value["price"] as number) <= 500);
  });

  it("string length bounds", () => {
    for (let seed = 0; seed < 20; seed++) {
      const v = generateFromSchema({ type: "string", minLength: 30, maxLength: 40 }, seed) as string;
      assert.ok(v.length >= 30 && v.length <= 40, v);
      const short = generateFromSchema({ type: "string", maxLength: 3 }, seed) as string;
      assert.ok(short.length <= 3);
    }
  });

  it("patterns, checked against the real RegExp", () => {
    const patterns = ["^[A-Z]{3}-\\d{4}$", "^(cus|acct)_[a-z0-9]{8,12}$", "^\\w+@\\w+\\.com$", "^[^0-9]{5}$", "^#?[0-9a-fA-F]{6}$"];
    for (const pattern of patterns) {
      for (let seed = 0; seed < 10; seed++) {
        const v = generateFromSchema({ type: "string", pattern }, seed) as string;
        assert.match(v, new RegExp(pattern, "u"), `${pattern} -> ${v}`);
      }
    }
  });

  it("a pattern past the generator falls back to the format, never a wrong match", () => {
    assert.equal(stringForPattern("^(?=.*\\d)\\w+$", practiceRandom(1)), undefined);
    assert.equal(stringForPattern("^(a)\\1$", practiceRandom(1)), undefined);
    const v = gen({ type: "string", pattern: "^(?=x)y$", format: "email" }) as string;
    assert.match(v, /@example\.com$/);
  });

  it("numbers: minimum, maximum, exclusive bounds (3.0 and 3.1), multipleOf", () => {
    for (let seed = 0; seed < 30; seed++) {
      const n = generateFromSchema({ type: "integer", minimum: 10, maximum: 12 }, seed) as number;
      assert.ok(Number.isInteger(n) && n >= 10 && n <= 12);
      const ex30 = generateFromSchema({ type: "integer", minimum: 0, maximum: 2, exclusiveMinimum: true, exclusiveMaximum: true }, seed);
      assert.equal(ex30, 1);
      const ex31 = generateFromSchema({ type: "integer", exclusiveMinimum: 5, exclusiveMaximum: 7 }, seed);
      assert.equal(ex31, 6);
      const m = generateFromSchema({ type: "number", minimum: 0, maximum: 100, multipleOf: 0.25 }, seed) as number;
      assert.ok(m >= 0 && m <= 100 && Math.abs(m * 4 - Math.round(m * 4)) < 1e-9, String(m));
      const f = generateFromSchema({ type: "number", minimum: 1.5, maximum: 2.5 }, seed) as number;
      assert.ok(f >= 1.5 && f <= 2.5);
    }
  });

  it("booleans and type arrays with null", () => {
    assert.equal(typeof gen({ type: "boolean" }), "boolean");
    assert.equal(typeof gen({ type: ["null", "string"] }), "string");
    assert.equal(typeof gen({ type: "integer", nullable: true }), "number");
  });

  it("arrays: minItems, maxItems, uniqueItems, prefixItems", () => {
    assert.equal((gen({ type: "array", items: { type: "string" } }) as unknown[]).length, 2);
    assert.equal((gen({ type: "array", items: { type: "string" }, minItems: 5 }) as unknown[]).length, 5);
    assert.equal((gen({ type: "array", items: { type: "string" }, maxItems: 1 }) as unknown[]).length, 1);
    assert.equal((gen({ type: "array", items: { type: "string" }, minItems: 500 }) as unknown[]).length, 10);
    const unique = gen({ type: "array", items: { type: "integer", enum: [1, 2, 3] }, minItems: 3, uniqueItems: true }) as number[];
    assert.equal(new Set(unique).size, unique.length);
    assert.deepEqual(gen({ type: "array", prefixItems: [{ const: "a" }, { const: 1 }] }), ["a", 1]);
  });

  it("objects: required fields kept under the property cap, additionalProperties", () => {
    const props: Record<string, JsonSchema> = {};
    for (let i = 0; i < 60; i++) props[`f${i}`] = { type: "integer" };
    const value = gen({ type: "object", properties: props, required: ["f59"] }) as Record<string, unknown>;
    assert.equal(Object.keys(value).length, 40);
    assert.ok("f59" in value);
    const map = gen({ type: "object", additionalProperties: { type: "integer" } }) as Record<string, unknown>;
    assert.equal(Object.keys(map).length, 2);
    assert.ok(Object.values(map).every((v) => typeof v === "number"));
  });

  it("readOnly and writeOnly by direction", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { id: { type: "string", readOnly: true }, password: { type: "string", writeOnly: true } },
    };
    assert.deepEqual(Object.keys(gen(schema, 1, "response") as object), ["id"]);
    assert.deepEqual(Object.keys(gen(schema, 1, "request") as object), ["password"]);
  });

  it("allOf merges properties and required", () => {
    const merged = mergeAllOf({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "integer" } }, required: ["b"] },
      ],
    });
    assert.deepEqual(Object.keys(merged["properties"] as object).sort(), ["a", "b"]);
    assert.deepEqual((merged["required"] as string[]).sort(), ["a", "b"]);
    const value = gen({ allOf: [{ type: "object", properties: { a: { const: 1 } } }, { properties: { b: { const: 2 } } }] });
    assert.deepEqual(value, { a: 1, b: 2 });
  });

  it("oneOf / anyOf pick a branch, skip null, and fill a discriminator", () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: "object", title: "Cat", properties: { kind: { type: "string" }, meows: { type: "boolean" } } },
        { type: "object", title: "Dog", properties: { kind: { type: "string" }, barks: { type: "boolean" } } },
      ],
      discriminator: { propertyName: "kind", mapping: { cat: "#/c", dog: "#/d" } },
    };
    const kinds = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      const v = generateFromSchema(schema, seed) as Record<string, unknown>;
      kinds.add(v["kind"] as string);
      assert.equal(v["kind"] === "cat", "meows" in v);
    }
    assert.deepEqual([...kinds].sort(), ["cat", "dog"]);
    assert.equal(typeof gen({ anyOf: [{ type: "null" }, { type: "integer" }] }), "number");
  });

  it("recursion stops at the depth limit and at a stored cycle cut", () => {
    // A self-similar schema as deep as storage could leave it.
    let node: JsonSchema = { type: "object", properties: { name: { type: "string" } } };
    for (let i = 0; i < 20; i++) node = { type: "object", properties: { name: { type: "string" }, child: node } };
    let value = gen(node) as Record<string, unknown> | undefined;
    let depth = 0;
    while (value !== undefined && typeof value["child"] === "object") {
      value = value["child"] as Record<string, unknown>;
      depth++;
    }
    assert.ok(depth <= PRACTICE_MAX_DEPTH, String(depth));
    const cut = gen({ type: "object", properties: { parent: { type: "object", "x-octri-truncated": "recursive" } } });
    assert.deepEqual(cut, { parent: {} });
  });

  it("stays under the size cap on a wide, deep schema", () => {
    const leaf: JsonSchema = { type: "object", properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`description_${i}`, { type: "string", minLength: 150 }])) };
    const schema: JsonSchema = { type: "array", minItems: 10, items: { type: "object", properties: { rows: { type: "array", minItems: 10, items: leaf } } } };
    const value = gen(schema);
    assert.ok(JSON.stringify(value).length <= PRACTICE_MAX_CHARS, String(JSON.stringify(value).length));
    assert.ok(Array.isArray(value));
  });

  it("an empty or unknown schema gives null rather than throwing", () => {
    assert.equal(generateFromSchema(undefined, 1), null);
    assert.equal(gen({}), null);
  });
});
