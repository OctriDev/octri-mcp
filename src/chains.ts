import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { processEnv, type EnvSource } from "./env.js";
import {
  buildOperationRequest,
  describeRequest,
  failedAnswer,
  formatResponse,
  missingRequired,
  sendOperationRequest,
  type FailedAnswer,
  type McpToolsResponse,
  type OperationResult,
  type OperationTool,
  type PendingRequest,
} from "./operations.js";

// ─── Chained tools ─────────────────────────────────────────────────────────────
//
// An owner-defined tool that calls several endpoints in order. Each step calls
// one operation tool, with inputs mapped from the chained tool's arguments or
// from earlier steps' responses by a small path syntax: `{{args.email}}`,
// `{{steps.create.body.id}}`, `{{steps.list.body.data[0].id}}`. A reference is
// looked up, never evaluated: there is no code, no filter and no arithmetic.
//
// The engine takes a definition and nothing else about where it came from, so
// anything that can emit the same data (the MCP page today, a written guide
// later) gets the same permissions, approval, dry run and usage.
//
// Mirrors `McpChainManifest` and the reference parser in @octri/shared (this
// package does not depend on it). That one decides what may publish; this one
// re-checks at call time and fails closed.

export interface ChainStep {
  /** What later steps call it: `steps.<id>.body`. */
  id: string;
  /** The endpoint's published operation tool, embedded so a chain runs inside any group. */
  tool: OperationTool;
  /** Keyed by the operation tool's input names, values carry `{{ }}` references. */
  inputs: Record<string, unknown>;
}

export interface ChainTool {
  slug: string;
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  steps: ChainStep[];
  /** What the tool returns. Absent: the last step's response body. */
  output?: unknown;
  /** `confirm` when any step writes or asks first. */
  policy: "auto" | "confirm";
  readOnly: boolean;
  destructive: boolean;
  tags?: string[];
}

/** How long a whole chain may take; each step still has the per-call limit. */
export const CHAIN_TIMEOUT_MS = 120_000;
const STEPS_MAX = 10;
const REF_MAX = 256;
const REF_DEPTH_MAX = 32;

// ── References ───────────────────────────────────────────────────────────────

export type ChainRef =
  | { root: "args"; path: (string | number)[] }
  | { root: "steps"; step: string; part: "status" | "body"; path: (string | number)[] };

/** Parses the text between `{{` and `}}`. Same grammar as `parseMcpRef` in @octri/shared. */
export function parseRef(raw: string): ChainRef | { error: string } {
  const text = raw.trim();
  if (text === "" || text.length > REF_MAX) return { error: `"${text}" is not a reference.` };
  const name = /^[A-Za-z0-9_$-]+/;
  const first = name.exec(text);
  if (first === null) return { error: `"${text}" must start with args or steps.` };
  const segments: (string | number)[] = [first[0]];
  let i = first[0].length;
  while (i < text.length) {
    const rest = text.slice(i);
    const dotted = rest.startsWith(".") ? name.exec(rest.slice(1)) : null;
    if (dotted !== null) {
      segments.push(dotted[0]);
      i += 1 + dotted[0].length;
      continue;
    }
    const index = /^\[(\d{1,9})\]/.exec(rest);
    if (index !== null) {
      segments.push(Number(index[1]));
      i += index[0].length;
      continue;
    }
    const quoted = /^\["([^"\\]{1,128})"\]/.exec(rest);
    if (quoted !== null) {
      segments.push(quoted[1] ?? "");
      i += quoted[0].length;
      continue;
    }
    return { error: `"${text}" is not a reference.` };
  }
  if (segments.length - 1 > REF_DEPTH_MAX) return { error: `"${text}" is too deep.` };
  const [root, ...path] = segments;
  if (root === "args") return { root: "args", path };
  if (root === "steps") {
    const [step, part, ...rest] = path;
    if (typeof step !== "string" || (part !== "body" && part !== "status")) {
      return { error: `"${text}" must read steps.<id>.body or steps.<id>.status.` };
    }
    if (part === "status" && rest.length > 0) return { error: `"${text}": a status has no fields.` };
    return { root: "steps", step, part, path: rest };
  }
  return { error: `"${text}" must start with args or steps.` };
}

type TemplatePart = string | { raw: string; ref: ChainRef };

/** Splits a template string into text and references. `\{{` is a literal `{{`. */
export function splitTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\\{{", i)) {
      literal += "{{";
      i += 3;
      continue;
    }
    if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i + 2);
      if (end === -1) throw new Error("A {{ in the tool's mapping is never closed.");
      const raw = text.slice(i + 2, end).trim();
      const ref = parseRef(raw);
      if ("error" in ref) throw new Error(`The tool's mapping has a bad reference: ${ref.error}`);
      if (literal !== "") parts.push(literal);
      literal = "";
      parts.push({ raw, ref });
      i = end + 2;
      continue;
    }
    literal += text[i];
    i += 1;
  }
  if (literal !== "") parts.push(literal);
  return parts;
}

/** What a step left behind for later steps to read. */
export interface StepResult {
  status: number;
  /** The response parsed as JSON, or its text when it is not JSON. */
  body: unknown;
}

export interface ChainScope {
  args: Record<string, unknown>;
  steps: Map<string, StepResult>;
}

/** `undefined` when the path leads nowhere. Own properties only: no prototype walk. */
function walk(value: unknown, path: (string | number)[]): unknown {
  let node = value;
  for (const segment of path) {
    if (node === null || typeof node !== "object") return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(node)) return undefined;
      node = node[segment];
    } else {
      if (!Object.hasOwn(node, segment)) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
  }
  return node;
}

/**
 * Stands in for a value an earlier step has not produced yet, while the chain
 * is planned for an approval prompt or a dry run. URL-safe and JSON-safe, so it
 * goes through the real serializer untouched and is swapped for the readable
 * reference afterwards.
 */
const SENTINEL = (n: number) => `__octri_ref_${n}__`;

interface ResolveContext {
  scope: ChainScope;
  /** Set while planning: step references become sentinels, recorded here. */
  placeholders?: string[];
}

function lookup(ref: ChainRef, raw: string, context: ResolveContext): unknown {
  if (ref.root === "args") return walk(context.scope.args, ref.path);
  const result = context.scope.steps.get(ref.step);
  if (result === undefined) {
    if (context.placeholders !== undefined) {
      context.placeholders.push(raw);
      return SENTINEL(context.placeholders.length - 1);
    }
    throw new Error(`{{${raw}}} reads a step that has not run.`);
  }
  return ref.part === "status" ? result.status : walk(result.body, ref.path);
}

/**
 * A template with its references filled in. A string that is one whole
 * reference takes the referenced value as it is (a number stays a number); a
 * reference inside text is written into the text. A reference that leads
 * nowhere leaves the value out.
 */
export function resolveTemplate(value: unknown, context: ResolveContext): unknown {
  if (typeof value === "string") {
    const parts = splitTemplate(value);
    if (parts.length === 1 && typeof parts[0] !== "string" && parts[0] !== undefined) {
      return lookup(parts[0].ref, parts[0].raw, context);
    }
    return parts
      .map((part) => {
        if (typeof part === "string") return part;
        const found = lookup(part.ref, part.raw, context);
        if (found === undefined || found === null) return "";
        return typeof found === "object" ? JSON.stringify(found) : String(found);
      })
      .join("");
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, context)).filter((item) => item !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveTemplate(item, context);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

function stepInputs(step: ChainStep, context: ResolveContext): Record<string, unknown> {
  const resolved = resolveTemplate(step.inputs, context);
  return resolved !== null && typeof resolved === "object" && !Array.isArray(resolved)
    ? (resolved as Record<string, unknown>)
    : {};
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── Planning ─────────────────────────────────────────────────────────────────

/** One step as it will be sent, with values from earlier responses shown as references. */
export interface PlannedStep {
  id: string;
  tool: string;
  request: PendingRequest;
}

function swapSentinels(text: string, placeholders: string[]): string {
  return text.replace(/__octri_ref_(\d+)__/g, (match, n: string) => {
    const raw = placeholders[Number(n)];
    return raw !== undefined ? `{${raw}}` : match;
  });
}

/**
 * Every request the chain will send, built before any of them is: what an
 * approval prompt lists and a dry run returns. Fails on what would fail later
 * anyway (a missing argument, a step input that cannot be built), so a person
 * is never asked to approve a chain that cannot run.
 */
export function planChain(
  chain: ChainTool,
  meta: McpToolsResponse,
  args: Record<string, unknown>,
  env: EnvSource = processEnv(),
): { ok: true; steps: PlannedStep[] } | { ok: false; text: string } {
  if (chain.steps.length === 0 || chain.steps.length > STEPS_MAX) {
    return { ok: false, text: `Error: ${chain.name} has ${chain.steps.length} steps; a chained tool has 1 to ${STEPS_MAX}.` };
  }
  const absent = missingRequired(chain.inputSchema, args);
  if (absent.length > 0) {
    return {
      ok: false,
      text: `Error: ${chain.name} is missing required ${absent.length === 1 ? "argument" : "arguments"}: ${absent.join(", ")}.`,
    };
  }
  const placeholders: string[] = [];
  const context: ResolveContext = { scope: { args, steps: new Map() }, placeholders };
  const steps: PlannedStep[] = [];
  for (const [index, step] of chain.steps.entries()) {
    let inputs: Record<string, unknown>;
    try {
      inputs = stepInputs(step, context);
    } catch (err) {
      return { ok: false, text: `Error: step ${index + 1} (${step.id}): ${err instanceof Error ? err.message : String(err)}` };
    }
    const built = buildOperationRequest(step.tool, meta, inputs, env);
    if (!built.ok) return { ok: false, text: `Error: step ${index + 1} (${step.id}) cannot be built. ${built.text.replace(/^Error: /, "")}` };
    const pending = built.request.pending;
    steps.push({
      id: step.id,
      tool: step.tool.name,
      request: {
        method: pending.method,
        url: swapSentinels(pending.url, placeholders),
        ...(pending.body !== undefined ? { body: swapSentinels(pending.body, placeholders) } : {}),
      },
    });
  }
  return { ok: true, steps };
}

/** The numbered request list an approval prompt and a dry run show. */
export function describePlan(steps: PlannedStep[]): string {
  return steps
    .map((step, i) => `${i + 1}. ${step.tool}: ${describeRequest(step.request).replace(/\n/g, "\n   ")}`)
    .join("\n\n");
}

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * Runs once, before the first request, with every planned request. Returns
 * null to go ahead, or the result to hand the agent instead (dry run, declined,
 * blocked).
 */
export type ChainGate = (steps: PlannedStep[]) => Promise<OperationResult | null>;

/** Reported for each request a chain actually sent. */
export interface StepEvent {
  step: ChainStep;
  /** The arguments the step was sent with, its templates filled in. */
  inputs: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  /** On a failed step: the status it got, or null when no answer came. */
  failedStatus?: number | null;
  /** The status the answer came back with, when one came. */
  status?: number;
}

export interface RunChainOptions {
  gate?: ChainGate;
  env?: EnvSource;
  fetch?: typeof fetch;
  /** Called after each request is sent, for usage counting. */
  onStep?: (event: StepEvent) => void;
  /**
   * Called right before each request is sent. A string stops the chain there,
   * unsent, with that as the reason (a safety limit); null sends it.
   */
  beforeStep?: (step: ChainStep, inputs: Record<string, unknown>) => Promise<string | null>;
  /** Default `CHAIN_TIMEOUT_MS`. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Plans the chain, passes the plan through the gate once, then sends the steps
 * in order. Stops at the first step that fails (a non-2xx answer, a timeout, an
 * input that leads nowhere) and says which, and which steps already went
 * through: nothing is rolled back.
 */
export async function runChain(
  chain: ChainTool,
  meta: McpToolsResponse,
  args: Record<string, unknown>,
  options: RunChainOptions = {},
): Promise<OperationResult> {
  const env = options.env ?? processEnv();
  const now = options.now ?? Date.now;
  const plan = planChain(chain, meta, args, env);
  if (!plan.ok) return plan;

  if (options.gate !== undefined) {
    const held = await options.gate(plan.steps);
    if (held !== null) return held;
  }

  const deadline = now() + (options.timeoutMs ?? CHAIN_TIMEOUT_MS);
  const scope: ChainScope = { args, steps: new Map() };
  const sent: string[] = [];
  const total = chain.steps.length;
  const failed = (
    index: number,
    step: ChainStep,
    why: string,
    failedStatus?: number | null,
    failure?: FailedAnswer,
  ): OperationResult => ({
    ok: false,
    ...(failedStatus !== undefined ? { failedStatus, failedStep: step.tool } : {}),
    ...(failure !== undefined ? { failure } : {}),
    text:
      `Step ${index + 1} of ${total} (${step.id}: ${step.tool.http.method} ${step.tool.http.path}) failed. ${why}` +
      (sent.length > 0
        ? `\n\nAlready sent, and not undone: ${sent.join("; ")}.`
        : "\n\nNothing was sent before it."),
  });

  for (const [index, step] of chain.steps.entries()) {
    const remaining = deadline - now();
    if (remaining <= 0) return failed(index, step, `The chained tool ran out of time (${Math.round((options.timeoutMs ?? CHAIN_TIMEOUT_MS) / 1000)} s).`);
    let inputs: Record<string, unknown>;
    try {
      inputs = stepInputs(step, { scope });
    } catch (err) {
      return failed(index, step, err instanceof Error ? err.message : String(err));
    }
    const built = buildOperationRequest(step.tool, meta, inputs, env);
    if (!built.ok) return failed(index, step, built.text.replace(/^Error: /, ""));
    const refused = options.beforeStep !== undefined ? await options.beforeStep(step, inputs) : null;
    if (refused !== null) return { ...failed(index, step, refused), held: "limited" };

    const startedAt = now();
    let response;
    try {
      response = await sendOperationRequest(built.request, options.fetch ?? fetch, remaining);
    } catch (err) {
      options.onStep?.({ step, inputs, ok: false, durationMs: now() - startedAt, failedStatus: null });
      return failed(index, step, `The request did not complete: ${err instanceof Error ? err.message : String(err)}.`, null);
    }
    options.onStep?.({
      step,
      inputs,
      ok: response.ok,
      durationMs: now() - startedAt,
      status: response.status,
      ...(response.ok ? {} : { failedStatus: response.status }),
    });
    if (!response.ok) {
      return failed(index, step, formatResponse(built.request, response), response.status, failedAnswer(response));
    }
    sent.push(`step ${index + 1} ${step.id} ${response.status}`);
    scope.steps.set(step.id, { status: response.status, body: parseBody(response.text) });
  }

  let output: unknown;
  try {
    const last = chain.steps[chain.steps.length - 1];
    output = chain.output !== undefined
      ? resolveTemplate(chain.output, { scope })
      : last !== undefined ? scope.steps.get(last.id)?.body : undefined;
  } catch (err) {
    return { ok: false, text: `Every step succeeded, but the output could not be built: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    text: output === undefined ? "(no output)" : typeof output === "string" ? output : JSON.stringify(output, null, 2),
  };
}
