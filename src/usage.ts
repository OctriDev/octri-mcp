import type { AuditEvent } from "./limits.js";

// ─── Usage reporting ───────────────────────────────────────────────────────────

/** Mirrors `McpCallOutcome` in @octri/shared. */
export type CallOutcome = "ok" | "error" | "declined" | "blocked" | "dry_run" | "outage" | "practice" | "limited";

export interface CallEvent {
  tool: string;
  /** The endpoint slug of an operation tool, so a rename keeps its history. */
  slug?: string;
  /** The tool group the server was serving, so the owner sees use per group. */
  group?: string;
  /** Set on a request a chained tool sent: that tool's slug. */
  chain?: string;
  outcome: CallOutcome;
  durationMs: number;
  client?: string;
  at: string;
}

/** Events per report; the API refuses more than 50. */
const REPORT_BATCH = 50;
/** A queue this long is sent at once rather than waiting for the timer. */
const REPORT_EAGER_AT = 20;
const REPORT_INTERVAL_MS = 10_000;
const REPORT_TIMEOUT_MS = 5_000;

/**
 * Batches per-tool call events and sends them to the Octri API, which counts
 * them per tool for the owner's MCP page. Best effort by design: a report that
 * fails is dropped, never retried and never surfaced, because a usage counter
 * must not be able to slow down or break a tool call.
 *
 * Audit entries (every write an agent attempted, when the owner keeps an
 * audit log) ride the same batching to their own route.
 */
export class UsageReporter {
  private readonly queues = new Map<string, CallEvent[]>();
  private readonly auditQueues = new Map<string, AuditEvent[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly send: (url: string, body: string) => Promise<unknown> = (url, body) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      }),
    /**
     * How long a quiet queue waits before it is sent. The default spares a
     * self-hosted server a request per call; a host that writes the events
     * itself can afford a short wait, so its live feed keeps up with the calls.
     */
    private readonly intervalMs: number = REPORT_INTERVAL_MS,
  ) {}

  record(projectId: string, event: CallEvent): void {
    this.enqueue(this.queues, projectId, event);
  }

  audit(projectId: string, event: AuditEvent): void {
    this.enqueue(this.auditQueues, projectId, event);
  }

  private enqueue<T>(queues: Map<string, T[]>, projectId: string, event: T): void {
    const queue = queues.get(projectId) ?? [];
    queue.push(event);
    queues.set(projectId, queue);
    if (queue.length >= REPORT_EAGER_AT) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), this.intervalMs);
      // A pending report must never keep a finished server alive.
      // A Worker's timers have no unref.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batches: [string, string][] = [];
    const collect = <T>(queues: Map<string, T[]>, route: string, key: string) => {
      for (const [projectId, queue] of queues) {
        for (let i = 0; i < queue.length; i += REPORT_BATCH) {
          batches.push([
            `${this.apiUrl}/public/mcp/${encodeURIComponent(projectId)}/${route}`,
            JSON.stringify({ [key]: queue.slice(i, i + REPORT_BATCH) }),
          ]);
        }
      }
      queues.clear();
    };
    collect(this.queues, "events", "events");
    collect(this.auditQueues, "audit", "entries");
    await Promise.all(batches.map(([url, body]) => this.send(url, body).catch(() => undefined)));
  }
}

/** One reporter per process, shared by every session an HTTP transport opens. */
let processReporter: UsageReporter | undefined;

/**
 * The process-wide reporter for `apiUrl`, created on first use. It flushes when
 * the event loop is about to empty (stdin closed, the client went away): the
 * fetch keeps the loop alive until it settles, and the next beforeExit finds an
 * empty queue and lets the process go.
 */
export function processUsageReporter(apiUrl: string): UsageReporter {
  if (processReporter === undefined) {
    const created = new UsageReporter(apiUrl);
    processReporter = created;
    process.on("beforeExit", () => void created.flush());
  }
  return processReporter;
}
