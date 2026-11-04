import createOctriPython from "../vendor/octri-python/octri-python.mjs";

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
import { webAssembly, type WasmModule } from "./code-wasm.js";

// ─── Python: MicroPython built for Octri ───────────────────────────────────────
//
// sandbox/python/ builds MicroPython without its JavaScript bridge modules,
// with no filesystem, imports from files, OS, clock or raw memory access, and
// with 64-bit ints that overflow instead of growing. Each run gets a fresh
// instance: its memory is a new WebAssembly memory that may grow to 48 MB and
// no further. The VM asks `octriShouldStop` every 64 jumps and returns, and a
// yes aborts past every `except`.

/**
 * The Python value stack. Small enough that runaway recursion raises
 * RuntimeError before the wasm frames under it use up the host's native stack
 * (about 1 MB on a Node main thread or a Worker), deep enough for real scripts.
 */
const PYSTACK_WORDS = 4 * 1024;
/** The wasm memory ceiling the build sets (MAXIMUM_MEMORY); the heap must leave room for the rest. */
const WASM_MEMORY_CEILING = 48 * 1024 * 1024;

const SCRIPT_LINE = /File "<script>", line (\d+)/g;

export async function runPython(module: WasmModule, job: SandboxJob, bridge: SandboxBridge): Promise<SandboxOutcome> {
  const clock = new RunClock(job.limits);
  const logs = new OutputSink(job.limits.logBytes);
  // Generous: a deep traceback is trimmed to its ends afterwards, and its last line is the error.
  const errors = new OutputSink(256_000);
  let result: string | undefined;
  let resultTooLarge = false;
  let ended = false;

  const python = await createOctriPython({
    instantiateWasm(imports, done) {
      void webAssembly.instantiate(module, imports).then((instance) => done(instance as never, module as never));
      return {};
    },
    octriWrite: (stream, text) => (stream === 1 ? logs : errors).write(text),
    octriShouldStop: () => ended || clock.expired(),
    octriResult: (json) => {
      if (json.length > job.limits.resultBytes) resultTooLarge = true;
      else result = json;
    },
    octriCall: async (tool, argsJson) => {
      clock.beginWait();
      try {
        return await bridge(tool, argsJson);
      } catch {
        return undefined;
      } finally {
        clock.endWait();
      }
    },
  });

  const heap = Math.min(job.limits.memoryBytes, WASM_MEMORY_CEILING - 8 * 1024 * 1024);
  python._octri_init(heap, PYSTACK_WORDS);
  const size = python.lengthBytesUTF8(job.source);
  const src = python._malloc(size + 1);
  python.stringToUTF8(job.source, src, size + 1);

  // The total clock also covers a script stuck in one long call.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const totalLimit = new Promise<"total">((resolve) => {
    timer = setTimeout(() => resolve("total"), job.limits.totalMs);
  });
  let code: number | "total" | "crashed" | "recursion";
  try {
    code = await Promise.race([python.ccall("octri_exec", "number", ["number", "number"], [src, size], { async: true }), totalLimit]);
  } catch (trap) {
    // The wasm trapped: nothing the script could catch. On a host thread with
    // a small native stack (about 1 MB on a Node main thread) the wasm frames
    // under deep recursion use it up a little before the Python stack runs
    // out, and the host throws RangeError. That is the script's recursion, so
    // it reads as Python's own error, not as an interpreter fault.
    code = trap instanceof RangeError ? "recursion" : "crashed";
  } finally {
    ended = true;
    clearTimeout(timer);
  }

  const base = { logs: logs.text(), logsTruncated: logs.truncated };
  if (code === 2 || code === "total") return { ...base, status: "timeout", error: TIMEOUT_TEXT(job.limits) };
  if (code === "crashed") return { ...base, status: "crashed", error: "The Python interpreter stopped unexpectedly." };
  if (code === "recursion") return { ...base, status: "error", error: "RuntimeError: maximum recursion depth exceeded" };
  if (code === 1) {
    const trace = ownTrace(errors.text(), job, SCRIPT_LINE);
    if (/^MemoryError\b/m.test(trace)) return { ...base, status: "memory", error: MEMORY_TEXT(job.limits) };
    return { ...base, status: "error", error: trace };
  }
  if (resultTooLarge) {
    return { ...base, status: "error", error: `The return value is over ${job.limits.resultBytes} bytes of JSON. Return less: pick the fields you need, or page.` };
  }
  return { ...base, status: "ok", result: result ?? "null" };
}
