// ─── Practice mode: values from a JSON Schema ──────────────────────────────────
//
// Believable, repeatable values for a response the spec documents a schema for
// but no example. Pure: no clock, no Math.random, no code built from strings
// (a Cloudflare Worker forbids that), so the same call gives the same answer on
// every runtime.

export type JsonSchema = Record<string, unknown>;

/** The date every generated timestamp sits near, so answers never drift with the clock. */
export const PRACTICE_ANCHOR_MS = Date.UTC(2026, 0, 15, 9, 30, 0);

/** Deepest a generated value nests. Stored schemas are already cut at their cycles. */
export const PRACTICE_MAX_DEPTH = 6;
/** Most items in a generated array, whatever `minItems` asks. */
export const PRACTICE_MAX_ITEMS = 10;
/** Most properties filled in one object. */
export const PRACTICE_MAX_PROPERTIES = 40;
/** Largest generated value, serialized. Past it, arrays shrink and depth drops. */
export const PRACTICE_MAX_CHARS = 32_000;
/** Longest generated string. */
const MAX_STRING = 200;

// ── Seeded randomness ─────────────────────────────────────────────────────────

/** FNV-1a over the parts, joined so ("ab","c") and ("a","bc") differ. */
export function seedFrom(...parts: string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface PracticeRandom {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** A new generator for a sub-part, so adding a field never reshuffles its siblings. */
  fork(label: string): PracticeRandom;
}

/** mulberry32: small, fast, and good enough for sample data. */
export function practiceRandom(seed: number): PracticeRandom {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => (max <= min ? min : min + Math.floor(next() * (max - min + 1))),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    fork: (label) => practiceRandom(seedFrom(String(seed), label)),
  };
}

// ── Word lists ────────────────────────────────────────────────────────────────

const FIRST_NAMES = ["Ada", "Grace", "Linus", "Maya", "Omar", "Priya", "Sofia", "Tomas", "Yuki", "Zara", "Noah", "Lena"];
const LAST_NAMES = ["Lovelace", "Hopper", "Okafor", "Nakamura", "Silva", "Novak", "Haddad", "Kim", "Patel", "Moreau"];
const WORDS = ["alpha", "harbor", "maple", "orbit", "cedar", "nova", "delta", "summit", "river", "atlas", "ember", "pixel"];
const COMPANIES = ["Acme Corp", "Globex", "Initech", "Umbrella Labs", "Stark Industries", "Wayne Enterprises", "Hooli"];
const CITIES = ["Lisbon", "Austin", "Toronto", "Berlin", "Nairobi", "Osaka", "Melbourne", "Bogota"];
const COUNTRIES = ["US", "GB", "DE", "FR", "JP", "CA", "BR", "KE"];
const CURRENCIES = ["usd", "eur", "gbp", "jpy", "cad"];
const STREETS = ["Main St", "Market St", "Oak Ave", "Harbor Rd", "King St"];
const SENTENCES = [
  "A sample value for practice mode.",
  "Generated from the API's documentation.",
  "Looks real, but nothing here was sent to the API.",
];

// ── Schema helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The schema's own type, the first non-null one when it lists several. */
export function schemaType(schema: JsonSchema): string | undefined {
  const t = schema["type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((x): x is string => typeof x === "string" && x !== "null");
  if (isRecord(schema["properties"]) || isRecord(schema["additionalProperties"])) return "object";
  if (schema["items"] !== undefined || Array.isArray(schema["prefixItems"])) return "array";
  return undefined;
}

/** `allOf` folded into one schema: properties and required merged, the first word wins elsewhere. */
export function mergeAllOf(schema: JsonSchema): JsonSchema {
  const parts = schema["allOf"];
  if (!Array.isArray(parts) || parts.length === 0) return schema;
  const { allOf: _allOf, ...rest } = schema;
  let merged: JsonSchema = { ...rest };
  for (const raw of parts) {
    if (!isRecord(raw)) continue;
    const part = mergeAllOf(raw);
    const properties = { ...(isRecord(part["properties"]) ? part["properties"] : {}), ...(isRecord(merged["properties"]) ? merged["properties"] : {}) };
    const required = [
      ...new Set([
        ...(Array.isArray(merged["required"]) ? merged["required"] : []),
        ...(Array.isArray(part["required"]) ? part["required"] : []),
      ]),
    ];
    merged = { ...part, ...merged };
    if (Object.keys(properties).length > 0) merged["properties"] = properties;
    if (required.length > 0) merged["required"] = required;
  }
  return merged;
}

/** One branch of a `oneOf` / `anyOf`, seeded, skipping a bare `null` branch. */
function chooseBranch(schema: JsonSchema, random: PracticeRandom): JsonSchema | undefined {
  const branches = (Array.isArray(schema["oneOf"]) ? schema["oneOf"] : Array.isArray(schema["anyOf"]) ? schema["anyOf"] : undefined)
    ?.filter(isRecord)
    .filter((b) => b["type"] !== "null");
  if (branches === undefined || branches.length === 0) return undefined;
  const branch = random.pick(branches);
  const { oneOf: _oneOf, anyOf: _anyOf, discriminator, ...rest } = schema;
  const merged = mergeAllOf({ allOf: [rest, branch] });
  // A discriminator names which branch this is: fill it with that branch's own value.
  if (isRecord(discriminator) && typeof discriminator["propertyName"] === "string") {
    const prop = discriminator["propertyName"];
    const props = isRecord(merged["properties"]) ? merged["properties"] : {};
    const own = isRecord(props[prop]) ? props[prop] : {};
    if (own["const"] === undefined && !Array.isArray(own["enum"])) {
      const mapping = isRecord(discriminator["mapping"]) ? Object.keys(discriminator["mapping"]) : [];
      const index = branches.indexOf(branch);
      const title = typeof branch["title"] === "string" ? branch["title"] : undefined;
      const value = mapping[index] ?? title;
      if (value !== undefined) merged["properties"] = { ...props, [prop]: { ...own, const: value } };
    }
  }
  return merged;
}

// ── Strings ───────────────────────────────────────────────────────────────────

const hex = (random: PracticeRandom, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[random.int(0, 15)]).join("");

function uuid(random: PracticeRandom): string {
  return `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-${"89ab"[random.int(0, 3)]}${hex(random, 3)}-${hex(random, 12)}`;
}

function isoDate(random: PracticeRandom): Date {
  // Within about a month either side of the anchor, on a whole second.
  return new Date(PRACTICE_ANCHOR_MS + random.int(-30 * 86_400, 30 * 86_400) * 1000);
}

function stringForFormat(format: string, random: PracticeRandom): string | undefined {
  switch (format) {
    case "date-time":
      return isoDate(random).toISOString().replace(".000Z", "Z");
    case "date":
      return isoDate(random).toISOString().slice(0, 10);
    case "time":
      return isoDate(random).toISOString().slice(11, 19);
    case "email":
    case "idn-email":
      return `${random.pick(FIRST_NAMES).toLowerCase()}.${random.pick(LAST_NAMES).toLowerCase()}@example.com`;
    case "uri":
    case "url":
    case "iri":
    case "uri-reference":
      return `https://example.com/${random.pick(WORDS)}/${random.int(100, 999)}`;
    case "hostname":
    case "idn-hostname":
      return `${random.pick(WORDS)}.example.com`;
    case "uuid":
      return uuid(random);
    case "ipv4":
      return `192.0.2.${random.int(1, 254)}`;
    case "ipv6":
      return `2001:db8::${hex(random, 4)}`;
    case "byte":
      return "cHJhY3RpY2UgbW9kZQ==";
    case "binary":
      return "(binary data)";
    case "password":
      return "********";
    case "duration":
      return `PT${random.int(1, 59)}M`;
    case "phone":
      return `+1555${random.int(1_000_000, 9_999_999)}`;
    default:
      return undefined;
  }
}

/** A string from a field's name, when the name says what it holds. */
function stringForName(name: string, random: PracticeRandom): string | undefined {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n === "id" || n === "uuid" || n === "guid") return `${random.pick(WORDS).slice(0, 3)}_${hex(random, 12)}`;
  if (n.endsWith("id") && n.length > 2) return `${n.slice(0, 3)}_${hex(random, 12)}`;
  if (n.includes("email")) return stringForFormat("email", random);
  if (n === "firstname" || n === "givenname") return random.pick(FIRST_NAMES);
  if (n === "lastname" || n === "surname" || n === "familyname") return random.pick(LAST_NAMES);
  if (n === "name" || n === "fullname" || n === "displayname" || n === "username") {
    return n === "username" ? `${random.pick(FIRST_NAMES).toLowerCase()}${random.int(1, 99)}` : `${random.pick(FIRST_NAMES)} ${random.pick(LAST_NAMES)}`;
  }
  if (n.includes("company") || n.includes("organization") || n === "org") return random.pick(COMPANIES);
  if (n.endsWith("url") || n.endsWith("uri") || n.includes("link") || n === "href" || n === "website") return stringForFormat("uri", random);
  if (n.endsWith("at") && n.length > 3) return stringForFormat("date-time", random);
  if (n.includes("date") || n.includes("timestamp")) return stringForFormat("date-time", random);
  if (n.includes("phone") || n === "mobile") return stringForFormat("phone", random);
  if (n === "city") return random.pick(CITIES);
  if (n === "country" || n === "countrycode") return random.pick(COUNTRIES);
  if (n === "currency") return random.pick(CURRENCIES);
  if (n.includes("street") || n === "address" || n === "line1") return `${random.int(1, 999)} ${random.pick(STREETS)}`;
  if (n === "zip" || n === "postalcode" || n === "postcode") return String(random.int(10000, 99999));
  if (n === "status" || n === "state") return random.pick(["active", "pending", "completed"]);
  if (n.includes("description") || n === "summary" || n === "message" || n === "note" || n === "comment") return random.pick(SENTENCES);
  if (n === "title" || n === "label") return `${random.pick(WORDS)} ${random.pick(WORDS)}`.replace(/^./, (c) => c.toUpperCase());
  if (n.includes("color") || n.includes("colour")) return `#${hex(random, 6)}`;
  if (n === "token" || n.includes("secret") || n.endsWith("key")) return `prac_${hex(random, 24)}`;
  if (n === "slug" || n === "handle") return `${random.pick(WORDS)}-${random.pick(WORDS)}`;
  if (n === "locale" || n === "language") return random.pick(["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP"]);
  if (n === "timezone") return random.pick(["UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo"]);
  return undefined;
}

// A small generator for the regex features `pattern` uses in practice: literals,
// escapes, classes, ranges, groups, alternation and quantifiers. Anything past
// that (lookaround, backreferences) gives up, and the caller falls back.

interface PatternState {
  src: string;
  i: number;
}

const CLASS_DIGIT = "0123456789";
const CLASS_WORD = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
const CLASS_SPACE = " ";

class PatternUnsupported extends Error {}

function readClass(state: PatternState): string {
  // After '['.
  let negate = false;
  if (state.src[state.i] === "^") {
    negate = true;
    state.i++;
  }
  let chars = "";
  let first = true;
  while (state.i < state.src.length && (state.src[state.i] !== "]" || first)) {
    first = false;
    let c = state.src[state.i++] as string;
    if (c === "\\") {
      const e = state.src[state.i++] as string;
      if (e === "d") { chars += CLASS_DIGIT; continue; }
      if (e === "w") { chars += CLASS_WORD; continue; }
      if (e === "s") { chars += CLASS_SPACE; continue; }
      c = e;
    }
    if (state.src[state.i] === "-" && state.src[state.i + 1] !== "]" && state.i + 1 < state.src.length) {
      state.i++;
      let end = state.src[state.i++] as string;
      if (end === "\\") end = state.src[state.i++] as string;
      const from = c.charCodeAt(0);
      const to = end.charCodeAt(0);
      for (let code = from; code <= to && code - from < 128; code++) chars += String.fromCharCode(code);
    } else {
      chars += c;
    }
  }
  state.i++; // ']'
  if (negate) {
    // A safe character the class leaves out.
    const pool = (CLASS_WORD).split("").filter((ch) => !chars.includes(ch));
    if (pool.length === 0) throw new PatternUnsupported("empty negated class");
    return pool.join("");
  }
  if (chars === "") throw new PatternUnsupported("empty class");
  return chars;
}

type Atom = (random: PracticeRandom) => string;

function readQuantifier(state: PatternState): [number, number] {
  const c = state.src[state.i];
  let range: [number, number] = [1, 1];
  if (c === "*") { range = [0, 3]; state.i++; }
  else if (c === "+") { range = [1, 4]; state.i++; }
  else if (c === "?") { range = [0, 1]; state.i++; }
  else if (c === "{") {
    const close = state.src.indexOf("}", state.i);
    const body = close === -1 ? "" : state.src.slice(state.i + 1, close);
    const m = /^(\d+)(,(\d*))?$/.exec(body);
    if (m === null) throw new PatternUnsupported("bad quantifier");
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? min + 3 : Number(m[3]);
    range = [min, Math.min(max, min + 16, 64)];
    state.i = close + 1;
  }
  if (state.src[state.i] === "?" || state.src[state.i] === "+") state.i++; // lazy / possessive
  return range;
}

function readAlternatives(state: PatternState): Atom {
  const alternatives: Atom[][] = [[]];
  while (state.i < state.src.length) {
    const c = state.src[state.i] as string;
    if (c === ")") break;
    if (c === "|") {
      state.i++;
      alternatives.push([]);
      continue;
    }
    let atom: Atom;
    if (c === "^" || c === "$") {
      state.i++;
      continue;
    } else if (c === "(") {
      state.i++;
      if (state.src[state.i] === "?") {
        if (state.src[state.i + 1] === ":") state.i += 2;
        else throw new PatternUnsupported("lookaround or named group");
      }
      const inner = readAlternatives(state);
      if (state.src[state.i] !== ")") throw new PatternUnsupported("unclosed group");
      state.i++;
      atom = inner;
    } else if (c === "[") {
      state.i++;
      const chars = readClass(state);
      atom = (r) => chars[r.int(0, chars.length - 1)] as string;
    } else if (c === ".") {
      state.i++;
      atom = (r) => CLASS_WORD[r.int(0, 61)] as string;
    } else if (c === "\\") {
      const e = state.src[state.i + 1] as string;
      state.i += 2;
      if (e === "d") atom = (r) => CLASS_DIGIT[r.int(0, 9)] as string;
      else if (e === "w") atom = (r) => CLASS_WORD[r.int(0, 61)] as string;
      else if (e === "s") atom = () => " ";
      else if (/[1-9bBkpP]/.test(e)) throw new PatternUnsupported("backreference or property escape");
      else atom = () => e;
    } else {
      state.i++;
      atom = () => c;
    }
    const [min, max] = readQuantifier(state);
    const base = atom;
    (alternatives[alternatives.length - 1] as Atom[]).push(
      min === 1 && max === 1 ? base : (r) => Array.from({ length: r.int(min, max) }, () => base(r)).join(""),
    );
  }
  return (r) => (r.pick(alternatives) as Atom[]).map((a) => a(r)).join("");
}

/** A string matching `pattern`, or undefined when the pattern is past this generator or the result fails it. */
export function stringForPattern(pattern: string, random: PracticeRandom): string | undefined {
  try {
    const state: PatternState = { src: pattern, i: 0 };
    const generate = readAlternatives(state);
    if (state.i < pattern.length) return undefined;
    const value = generate(random).slice(0, MAX_STRING);
    // Checked against the real thing. RegExp is allowed on a Worker; only eval is not.
    return new RegExp(pattern, "u").test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function fitLength(value: string, schema: JsonSchema, random: PracticeRandom): string {
  const min = typeof schema["minLength"] === "number" ? Math.min(schema["minLength"], MAX_STRING) : 0;
  const max = typeof schema["maxLength"] === "number" ? Math.max(schema["maxLength"], min) : MAX_STRING;
  let out = value;
  while (out.length < min) out += random.pick(WORDS);
  return out.slice(0, Math.max(max, min));
}

function generateString(schema: JsonSchema, name: string | undefined, random: PracticeRandom): string {
  if (typeof schema["pattern"] === "string") {
    const matched = stringForPattern(schema["pattern"], random);
    if (matched !== undefined) return matched;
  }
  const format = typeof schema["format"] === "string" ? stringForFormat(schema["format"], random) : undefined;
  if (format !== undefined) return format;
  const named = name !== undefined ? stringForName(name, random) : undefined;
  return fitLength(named ?? `${random.pick(WORDS)}_${random.pick(WORDS)}`, schema, random);
}

// ── Numbers ───────────────────────────────────────────────────────────────────

function generateNumber(schema: JsonSchema, integer: boolean, name: string | undefined, random: PracticeRandom): number {
  const n = (name ?? "").toLowerCase();
  // OpenAPI 3.0 spells exclusive bounds as booleans beside min/max; 3.1 as numbers.
  let min = typeof schema["minimum"] === "number" ? schema["minimum"] : undefined;
  let max = typeof schema["maximum"] === "number" ? schema["maximum"] : undefined;
  const step = integer ? 1 : 0.01;
  if (typeof schema["exclusiveMinimum"] === "number") min = schema["exclusiveMinimum"] + step;
  else if (schema["exclusiveMinimum"] === true && min !== undefined) min += step;
  if (typeof schema["exclusiveMaximum"] === "number") max = schema["exclusiveMaximum"] - step;
  else if (schema["exclusiveMaximum"] === true && max !== undefined) max -= step;
  // A name hint picks a believable range when the schema leaves it open.
  const [hintMin, hintMax] =
    /price|amount|total|cost|balance|fee/.test(n) ? [5, 500]
    : /count|quantity|qty|size|total/.test(n) ? [1, 50]
    : /age/.test(n) ? [18, 80]
    : /year/.test(n) ? [2020, 2026]
    : /page|limit|offset|perpage/.test(n) ? [1, 20]
    : /percent|rate|ratio|score/.test(n) ? [0, 100]
    : /lat/.test(n) ? [-60, 60]
    : /lon|lng/.test(n) ? [-150, 150]
    : [1, 1000];
  const lo = min ?? (max !== undefined ? Math.min(hintMin, max) : hintMin);
  const hi = max ?? Math.max(lo, hintMax, lo + 10);
  let value = integer ? random.int(Math.ceil(lo), Math.floor(hi)) : Math.round((lo + random.next() * (hi - lo)) * 100) / 100;
  const multiple = schema["multipleOf"];
  if (typeof multiple === "number" && multiple > 0) {
    value = Math.ceil(lo / multiple) * multiple + Math.floor(random.next() * Math.max(1, Math.floor((hi - lo) / multiple) + 1)) * multiple;
    if (value > hi) value = Math.ceil(lo / multiple) * multiple;
    value = Number(value.toFixed(10));
  }
  return value;
}

// ── The generator ─────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** `response` drops writeOnly fields; `request` drops readOnly ones. Default: response. */
  mode?: "response" | "request";
  /** Deepest nesting. Default {@link PRACTICE_MAX_DEPTH}. */
  maxDepth?: number;
  /** Most array items. Default {@link PRACTICE_MAX_ITEMS}. */
  maxItems?: number;
}

interface Walk {
  mode: "response" | "request";
  maxDepth: number;
  maxItems: number;
  /** Nodes left to build: a hard stop for a wide schema. */
  budget: number;
}

/** The value a field takes from its own documented words, before generating anything. */
function documented(schema: JsonSchema, random: PracticeRandom): { value: unknown } | undefined {
  if (schema["const"] !== undefined) return { value: schema["const"] };
  if (schema["example"] !== undefined) return { value: schema["example"] };
  if (Array.isArray(schema["examples"]) && schema["examples"].length > 0) return { value: schema["examples"][0] };
  if (Array.isArray(schema["enum"])) {
    const options = schema["enum"].filter((v) => v !== null);
    if (options.length > 0) return { value: random.pick(options) };
  }
  if (schema["default"] !== undefined) return { value: schema["default"] };
  return undefined;
}

function walk(raw: unknown, name: string | undefined, random: PracticeRandom, depth: number, w: Walk): unknown {
  if (!isRecord(raw)) return null;
  w.budget--;
  let schema = mergeAllOf(raw);
  const branch = chooseBranch(schema, random);
  if (branch !== undefined) schema = branch;

  const own = documented(schema, random);
  if (own !== undefined) return own.value;

  const type = schemaType(schema);
  // A leaf the stored schema cut at a cycle or a depth: the smallest honest value.
  const cut = schema["x-octri-truncated"] !== undefined;
  if (depth >= w.maxDepth || w.budget <= 0 || cut) {
    if (type === "object") return {};
    if (type === "array") return [];
    if (type === undefined) return null;
  }

  switch (type) {
    case "string":
      return generateString(schema, name, random);
    case "integer":
      return generateNumber(schema, true, name, random);
    case "number":
      return generateNumber(schema, false, name, random);
    case "boolean":
      return random.next() < 0.5;
    case "array": {
      const items = Array.isArray(schema["prefixItems"]) ? undefined : schema["items"];
      if (Array.isArray(schema["prefixItems"])) {
        return schema["prefixItems"].slice(0, w.maxItems).map((s, i) => walk(s, name, random.fork(`#${i}`), depth + 1, w));
      }
      const minItems = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
      const maxItems = typeof schema["maxItems"] === "number" ? schema["maxItems"] : Number.POSITIVE_INFINITY;
      const count = Math.min(Math.max(minItems, Math.min(2, maxItems)), maxItems, w.maxItems);
      const out: unknown[] = [];
      const seen = new Set<string>();
      const singular = name?.replace(/(ies)$/, "y").replace(/s$/, "");
      for (let i = 0, tries = 0; out.length < count && tries < count * 4; i++, tries++) {
        const value = walk(items, singular, random.fork(`#${i}`), depth + 1, w);
        if (schema["uniqueItems"] === true) {
          const key = JSON.stringify(value);
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(value);
      }
      return out;
    }
    case "object": {
      const props = isRecord(schema["properties"]) ? schema["properties"] : {};
      const out: Record<string, unknown> = {};
      const required = new Set(Array.isArray(schema["required"]) ? schema["required"] : []);
      // Required fields first, so a cap never drops one.
      const keys = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
      for (const key of keys.slice(0, PRACTICE_MAX_PROPERTIES)) {
        const prop = props[key];
        if (!isRecord(prop)) continue;
        if (w.mode === "response" && prop["writeOnly"] === true) continue;
        if (w.mode === "request" && prop["readOnly"] === true) continue;
        out[key] = walk(prop, key, random.fork(key), depth + 1, w);
      }
      const extra = schema["additionalProperties"];
      if (Object.keys(props).length === 0 && isRecord(extra)) {
        for (let i = 0; i < 2; i++) {
          const key = `${random.pick(WORDS)}_${i + 1}`;
          out[key] = walk(extra, key, random.fork(key), depth + 1, w);
        }
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * A value shaped like `schema`. Deterministic for the same schema and seed;
 * kept under {@link PRACTICE_MAX_CHARS} by building smaller until it fits.
 */
export function generateFromSchema(schema: JsonSchema | undefined, seed: number, options: GenerateOptions = {}): unknown {
  if (schema === undefined) return null;
  const mode = options.mode ?? "response";
  let maxDepth = options.maxDepth ?? PRACTICE_MAX_DEPTH;
  let maxItems = options.maxItems ?? PRACTICE_MAX_ITEMS;
  for (;;) {
    const value = walk(schema, undefined, practiceRandom(seed), 0, { mode, maxDepth, maxItems, budget: 4_000 });
    if (JSON.stringify(value ?? null).length <= PRACTICE_MAX_CHARS || maxDepth <= 1) return value;
    if (maxItems > 1) maxItems = Math.max(1, Math.floor(maxItems / 2));
    else maxDepth--;
  }
}

/** A seeded value for one named field, the way a whole object would fill it. */
export function generateField(schema: JsonSchema | undefined, name: string, seed: number): unknown {
  if (schema === undefined) return generateString({}, name, practiceRandom(seed));
  return walk(schema, name, practiceRandom(seed), 0, { mode: "response", maxDepth: PRACTICE_MAX_DEPTH, maxItems: 2, budget: 400 });
}
