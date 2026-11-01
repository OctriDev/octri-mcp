import type { CodeLanguage } from "./code-sdk.js";
import type { WasmModule } from "./code-wasm.js";

// ─── Code mode sandboxes ───────────────────────────────────────────────────────
//
// A script runs in an interpreter compiled to WebAssembly: QuickJS for
// TypeScript (types stripped first), a MicroPython built for Octri for Python.
// Neither can see the host. They get no filesystem, no network, no clock and
// no host objects; the one way out is `call(tool, argsJson)`, which the server
// answers by running the operation through its own call path. Strings cross
// the boundary, never objects, so nothing in the script can reach a host
// prototype.
//
// The interpreters are the same everywhere. Where they run differs: a Node
// host runs each script on a worker thread it can terminate (code-sandbox-node.ts),
// a Cloudflare Worker runs it in its own isolate, relying on the interpreters'
// own time and memory checks.

export interface SandboxLimits {
  /** Time the script may spend running, not counting time its calls wait on the API or the user. */
  execMs: number;
  /** Time a run may take in all, waits included. */
  totalMs: number;
  /** The interpreter's heap. */
  memoryBytes: number;
  /** What printing may produce in all; the rest is dropped and marked. */
  logBytes: number;
  /** The serialised return value; a longer one is refused with its size. */
  resultBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  execMs: 30_000,
  totalMs: 300_000,
  memoryBytes: 64 * 1024 * 1024,
  logBytes: 8_000,
  resultBytes: 24_000,
};

/**
 * A Worker shares 128 MB with everything else in the isolate, and Cloudflare
 * ends a request at its CPU limit (30 s by default on the paid plan). Running
 * time stops at 20 s so the interpreter ends a script cleanly first.
 */
export const WORKER_SANDBOX_LIMITS: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, execMs: 20_000, memoryBytes: 24 * 1024 * 1024 };

export interface SandboxJob {
  language: CodeLanguage;
  /** The program: the SDK preamble, then the script. */
  source: string;
  /** Lines before the script starts, so error line numbers can be given in the script's own terms. */
  lineOffset: number;
  /** The script's own line count: frames past it belong to the wrapper around it. */
  lineCount: number;
  limits: SandboxLimits;
}

/** Answers one SDK call from inside a script: the tool name and its arguments as JSON, an envelope back as JSON. */
export type SandboxBridge = (tool: string, argsJson: string) => Promise<string>;

export type SandboxStatus = "ok" | "error" | "timeout" | "memory" | "crashed";

export interface SandboxOutcome {
  status: SandboxStatus;
  /** The return value as JSON, when the script finished. */
  result?: string;
  /** What the script printed, capped. */
  logs: string;
  logsTruncated: boolean;
  /** The uncaught error, with the script's own line numbers. */
  error?: string;
}

/** The compiled interpreters a host has. A language without one is not offered. */
export interface SandboxWasm {
  quickjs?: WasmModule;
  python?: WasmModule;
}

export function languagesOf(wasm: SandboxWasm): CodeLanguage[] {
  return [...(wasm.quickjs !== undefined ? (["typescript"] as const) : []), ...(wasm.python !== undefined ? (["python"] as const) : [])];
}

export interface CodeSandbox {
  /** The languages this host can run. */
  languages: readonly CodeLanguage[];
  run(job: SandboxJob, bridge: SandboxBridge): Promise<SandboxOutcome>;
}

/** Collects printed output up to a byte budget. */
export class OutputSink {
  private parts: string[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  write(text: string): void {
    if (this.truncated || text === "") return;
    const room = this.limit - this.size;
    if (text.length > room) {
      this.parts.push(text.slice(0, Math.max(0, room)));
      this.size = this.limit;
      this.truncated = true;
      return;
    }
    this.parts.push(text);
    this.size += text.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

/**
 * The run clock. Running time excludes the time spent waiting on calls, so a
 * slow API or a person reading an approval prompt never times a script out;
 * the total clock still ends a run that waits forever.
 */
export class RunClock {
  private readonly started = Date.now();
  private waitedMs = 0;
  private waitStart: number | undefined;

  constructor(private readonly limits: Pick<SandboxLimits, "execMs" | "totalMs">) {}

  beginWait(): void {
    this.waitStart ??= Date.now();
  }

  endWait(): void {
    if (this.waitStart === undefined) return;
    this.waitedMs += Date.now() - this.waitStart;
    this.waitStart = undefined;
  }

  get waiting(): boolean {
    return this.waitStart !== undefined;
  }

  /** Running time so far. */
  execMs(): number {
    const now = Date.now();
    const waitingNow = this.waitStart !== undefined ? now - this.waitStart : 0;
    return now - this.started - this.waitedMs - waitingNow;
  }

  expired(): boolean {
    return this.execMs() > this.limits.execMs || Date.now() - this.started > this.limits.totalMs;
  }
}

/** Shifts `line N` references in an error so they count from the script's first line. */
export function scriptLines(text: string, offset: number, file: RegExp): string {
  return text.replace(file, (whole, line: string) => {
    const n = Number(line) - offset;
    return n >= 1 ? whole.replace(line, String(n)) : whole;
  });
}

/**
 * An error trace in the script's own terms: frames in the SDK preamble or the
 * wrapper around the script are dropped, the rest renumbered from its first
 * line, and the runaway middle of a deep recursion cut.
 */
export function ownTrace(trace: string, job: Pick<SandboxJob, "lineOffset" | "lineCount">, file: RegExp): string {
  const frame = new RegExp(file.source);
  const own = trace
    .trimEnd()
    .split("\n")
    .filter((line) => {
      const found = frame.exec(line);
      if (found === null) return true;
      const n = Number(found[1]);
      return n > job.lineOffset && n <= job.lineOffset + job.lineCount;
    })
    .join("\n");
  const lines = scriptLines(own, job.lineOffset, file).split("\n");
  if (lines.length <= 14) return lines.join("\n");
  return [...lines.slice(0, 5), `  ... ${lines.length - 11} more lines ...`, ...lines.slice(-6)].join("\n");
}

/** What a timed-out run says. */
export const TIMEOUT_TEXT = (limits: SandboxLimits) =>
  `The script ran out of time: it may run for ${Math.round(limits.execMs / 1000)} s (time waiting on API calls and approvals does not count), ` +
  `and a run may take ${Math.round(limits.totalMs / 60000)} min in all. Return sooner, or page through less data per run.`;

export const MEMORY_TEXT = (limits: SandboxLimits) =>
  `The script ran out of memory (${Math.round(limits.memoryBytes / (1024 * 1024))} MB). Keep less data at once: map or filter results before collecting them.`;
