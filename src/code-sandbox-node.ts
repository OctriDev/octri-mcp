import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { webAssembly } from "./code-wasm.js";
import {
  languagesOf,
  MEMORY_TEXT,
  RunClock,
  TIMEOUT_TEXT,
  type CodeSandbox,
  type SandboxBridge,
  type SandboxJob,
  type SandboxOutcome,
  type SandboxWasm,
} from "./code-sandbox.js";

// ─── Code mode on Node ─────────────────────────────────────────────────────────
//
// Each run gets its own worker thread with capped V8 memory, so a script never
// blocks the server's event loop, and the thread is terminated when its time
// is up whether or not the interpreter noticed. The interpreters are compiled
// once per process and handed to each thread.

/** Time past the limit the interpreter gets to stop on its own before the thread is terminated. */
const GRACE_MS = 2_000;
const THREAD_LIMITS = { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 };

export interface NodeSandboxOptions {
  /** Runs at once in this process; more are refused until one ends. Default 4. */
  concurrency?: number;
}

/** The first of these files that exists: beside a bundle, or in the package. */
function firstFile(candidates: readonly (string | undefined)[]): string | undefined {
  return candidates.find((path): path is string => path !== undefined && existsSync(path));
}

function resolved(specifier: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return undefined;
  }
}

let compiled: Promise<SandboxWasm> | undefined;

/** The interpreters, compiled once. A missing file leaves its language out rather than failing the server. */
export function loadSandboxWasm(): Promise<SandboxWasm> {
  compiled ??= (async () => {
    const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    const quickjs = firstFile([here("./vendor/quickjs.wasm"), resolved("@jitl/quickjs-wasmfile-release-sync/wasm")]);
    const python = firstFile([here("./vendor/octri-python.wasm"), here("../vendor/octri-python/octri-python.wasm")]);
    const compile = async (path: string | undefined) => (path === undefined ? undefined : webAssembly.compile(readFileSync(path)));
    const [quickjsModule, pythonModule] = await Promise.all([compile(quickjs), compile(python)]);
    return {
      ...(quickjsModule !== undefined ? { quickjs: quickjsModule } : {}),
      ...(pythonModule !== undefined ? { python: pythonModule } : {}),
    };
  })();
  return compiled;
}

function threadFile(): URL | undefined {
  const url = new URL("./code-sandbox-thread.js", import.meta.url);
  return existsSync(fileURLToPath(url)) ? url : undefined;
}

/**
 * The Node host's sandbox. Resolves to undefined when the interpreters or the
 * thread file are missing, so the server falls back to its other modes.
 */
export async function nodeCodeSandbox(options: NodeSandboxOptions = {}): Promise<CodeSandbox | undefined> {
  const file = threadFile();
  if (file === undefined) return undefined;
  let wasm: SandboxWasm;
  try {
    wasm = await loadSandboxWasm();
  } catch {
    return undefined;
  }
  const languages = languagesOf(wasm);
  if (languages.length === 0) return undefined;
  const concurrency = options.concurrency ?? 4;
  let running = 0;
  return {
    languages,
    async run(job, bridge) {
      if (running >= concurrency) {
        return {
          status: "crashed",
          logs: "",
          logsTruncated: false,
          error: `This server is running ${concurrency} scripts already. Try again in a moment.`,
        };
      }
      running += 1;
      try {
        return await runOnThread(file, wasm, job, bridge);
      } finally {
        running -= 1;
      }
    },
  };
}

function runOnThread(file: URL, wasm: SandboxWasm, job: SandboxJob, bridge: SandboxBridge): Promise<SandboxOutcome> {
  return new Promise((resolve) => {
    const clock = new RunClock({ execMs: job.limits.execMs + GRACE_MS, totalMs: job.limits.totalMs + GRACE_MS });
    const worker = new Worker(file, { workerData: { wasm, job }, resourceLimits: THREAD_LIMITS });
    let inFlight = 0;
    let settled = false;
    const settle = (outcome: SandboxOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      void worker.terminate();
      resolve(outcome);
    };
    const watch = setInterval(() => {
      if (clock.expired()) settle({ status: "timeout", logs: "", logsTruncated: false, error: TIMEOUT_TEXT(job.limits) });
    }, 250);
    worker.on("message", (message: { type: string; id?: number; tool?: string; argsJson?: string; outcome?: SandboxOutcome }) => {
      if (message.type === "done" && message.outcome !== undefined) {
        settle(message.outcome);
        return;
      }
      if (message.type !== "call" || message.id === undefined) return;
      const id = message.id;
      inFlight += 1;
      clock.beginWait();
      void bridge(message.tool ?? "", message.argsJson ?? "{}")
        .catch(() => JSON.stringify({ ok: false, error: { kind: "host", message: "The call could not be completed." } }))
        .then((answer) => {
          inFlight -= 1;
          if (inFlight === 0) clock.endWait();
          if (!settled) worker.postMessage({ type: "answer", id, answer });
        });
    });
    worker.on("error", (err: Error & { code?: string }) => {
      settle(
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? { status: "memory", logs: "", logsTruncated: false, error: MEMORY_TEXT(job.limits) }
          : { status: "crashed", logs: "", logsTruncated: false, error: `The sandbox stopped: ${err.message}` },
      );
    });
    worker.on("exit", () => settle({ status: "crashed", logs: "", logsTruncated: false, error: "The sandbox stopped unexpectedly." }));
  });
}
