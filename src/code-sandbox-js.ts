import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { transform } from "sucrase";

import {
  MEMORY_TEXT,
  OutputSink,
  RunClock,
  ownTrace,
  TIMEOUT_TEXT,
  type SandboxBridge,
  type SandboxJob,
  type SandboxOutcome,
} from "./code-sandbox.js";
import type { WasmModule } from "./code-wasm.js";

// ─── TypeScript: QuickJS ───────────────────────────────────────────────────────
//
// QuickJS keeps its own heap inside WebAssembly memory, so a script's objects,
// prototypes and `Function` are QuickJS's, never the host's: there is no
// constructor chain out. The context has no std/os modules, no fetch and no
// timers; QuickJS caps a BigInt's size itself, so a huge power fails at once.
// Memory and stack are capped per run, and the interrupt handler ends a
// script whose running time is up.

/**
 * QuickJS's own stack limit. Its frames also use the host's native stack, and
 * a Worker or a Node main thread has about 1 MB of it: 256 KB here stops deep
 * recursion with a RangeError before the host's stack runs out.
 */
const STACK_BYTES = 256 * 1024;

type SyncVariant = Exclude<Parameters<typeof newQuickJSWASMModuleFromVariant>[0], Promise<unknown>>;
// The variant's types describe its CommonJS build; under ESM its default export is the variant itself.
const releaseSync = ((RELEASE_SYNC as unknown as { default?: SyncVariant }).default ?? RELEASE_SYNC) as SyncVariant;
const SCRIPT_FILE = "script.js";
const SCRIPT_LINE = /script\.js:(\d+)/g;

/** Types out, nothing else changed: line numbers stay where the agent wrote them. */
export function stripTypes(source: string): string {
  return transform(source, { transforms: ["typescript"], disableESTransforms: true, keepUnusedImports: true }).code;
}

const modules = new WeakMap<WasmModule, Promise<QuickJSWASMModule>>();

/** One QuickJS module per compiled wasm; each run still gets its own runtime and heap. */
function quickjsFor(wasm: WasmModule): Promise<QuickJSWASMModule> {
  let found = modules.get(wasm);
  if (found === undefined) {
    found = newQuickJSWASMModuleFromVariant(newVariant(releaseSync, { wasmModule: wasm as never }) as SyncVariant);
    modules.set(wasm, found);
  }
  return found;
}

function classify(message: string): "timeout" | "memory" | "error" {
  if (/\binterrupted\b/i.test(message)) return "timeout";
  if (/out of memory|stack overflow/i.test(message)) return /stack overflow/i.test(message) ? "error" : "memory";
  return "error";
}

function errorText(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped !== null && typeof dumped === "object") {
    const { name, message, stack } = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : ""}`;
    return typeof stack === "string" && stack.trim() !== "" ? `${head}\n${stack.trimEnd()}` : head;
  }
  return String(dumped);
}

export async function runTypeScript(wasm: WasmModule, job: SandboxJob, bridge: SandboxBridge): Promise<SandboxOutcome> {
  const quickjs = await quickjsFor(wasm);
  const clock = new RunClock(job.limits);
  const logs = new OutputSink(job.limits.logBytes);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(job.limits.memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  let ended = false;
  runtime.setInterruptHandler(() => ended || clock.expired());
  const vm = runtime.newContext();

  let result: string | undefined;
  let failure: string | undefined;
  let done = false;
  let inFlight = 0;
  let wake: () => void = () => undefined;

  const define = (name: string, fn: Parameters<QuickJSContext["newFunction"]>[1]) => {
    const handle = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  };
  define("__octri_write", (text) => {
    logs.write(vm.getString(text));
  });
  define("__octri_result", (json) => {
    const value = vm.getString(json);
    if (value.length > job.limits.resultBytes) {
      failure = `The return value is over ${job.limits.resultBytes} bytes of JSON. Return less: pick the fields you need, or page.`;
    } else {
      result = value;
    }
    done = true;
    wake();
  });
  define("__octri_fail", (message) => {
    failure = vm.getString(message);
    done = true;
    wake();
  });
  define("__octri_call", (toolHandle, argsHandle) => {
    const tool = vm.getString(toolHandle);
    const args = vm.getString(argsHandle);
    const deferred = vm.newPromise();
    inFlight += 1;
    clock.beginWait();
    void bridge(tool, args)
      .catch(() => JSON.stringify({ ok: false, error: { kind: "host", message: "The call could not be completed." } }))
      .then((answer) => {
        inFlight -= 1;
        if (inFlight === 0) clock.endWait();
        if (ended) return;
        const value = vm.newString(answer);
        deferred.resolve(value);
        value.dispose();
        deferred.dispose();
        wake();
      });
    return deferred.handle;
  });

  const finish = (status: SandboxOutcome["status"], extra: Partial<SandboxOutcome> = {}): SandboxOutcome => {
    ended = true;
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // A handle still held by a call in flight: the runtime goes with the run anyway.
    }
    return { status, logs: logs.text(), logsTruncated: logs.truncated, ...extra };
  };
  const fromError = (message: string) => {
    const kind = classify(message);
    if (kind === "timeout") return finish("timeout", { error: TIMEOUT_TEXT(job.limits) });
    if (kind === "memory") return finish("memory", { error: MEMORY_TEXT(job.limits) });
    return finish("error", { error: ownTrace(message, job, SCRIPT_LINE) });
  };

  // The SDK preamble is plain JavaScript, which stripping leaves as it is.
  let source: string;
  try {
    source = stripTypes(job.source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = /\((\d+):(\d+)\)/.exec(message);
    const line = at !== null ? Number(at[1]) - job.lineOffset : undefined;
    return finish("error", {
      error: `SyntaxError: ${message.replace(/\s*\(\d+:\d+\)\s*$/, "")}${line !== undefined && line >= 1 ? ` (line ${line}, column ${at![2]})` : ""}`,
    });
  }
  const evaluated = vm.evalCode(source, SCRIPT_FILE);
  if (evaluated.error !== undefined) {
    const message = errorText(vm, evaluated.error);
    evaluated.error.dispose();
    return fromError(message);
  }
  evaluated.value.dispose();

  while (!done) {
    const jobs = runtime.executePendingJobs();
    if (jobs.error !== undefined) {
      const message = errorText(vm, jobs.error);
      jobs.error.dispose();
      return fromError(message);
    }
    if (done) break;
    if (clock.expired()) return finish("timeout", { error: TIMEOUT_TEXT(job.limits) });
    if (inFlight === 0) {
      if (runtime.hasPendingJob()) continue;
      return finish("error", {
        error: "The script is waiting on a promise that never settles. Await only SDK calls and promises they make.",
      });
    }
    // Wait for a call to come back, or for the total clock.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(10, job.limits.totalMs));
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = () => undefined;
  }

  if (failure !== undefined) {
    const kind = classify(failure);
    if (kind === "timeout") return finish("timeout", { error: TIMEOUT_TEXT(job.limits) });
    if (kind === "memory") return finish("memory", { error: MEMORY_TEXT(job.limits) });
    return finish("error", { error: ownTrace(failure, job, SCRIPT_LINE) });
  }
  return finish("ok", { result: result ?? "null" });
}
