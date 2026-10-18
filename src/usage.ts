// ─── Usage reporting ───────────────────────────────────────────────────────────

/** Mirrors `McpCallOutcome` in @octri/shared. */
export type CallOutcome = "ok" | "error" | "declined" | "blocked" | "dry_run";

export interface CallEvent {
  tool: string;
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
 */
export class UsageReporter {
  private readonly queues = new Map<string, CallEvent[]>();
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
  ) {}

  record(projectId: string, event: CallEvent): void {
    const queue = this.queues.get(projectId) ?? [];
    queue.push(event);
    this.queues.set(projectId, queue);
    if (queue.length >= REPORT_EAGER_AT) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), REPORT_INTERVAL_MS);
      // A pending report must never keep a finished server alive.
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batches: [string, CallEvent[]][] = [];
    for (const [projectId, queue] of this.queues) {
      for (let i = 0; i < queue.length; i += REPORT_BATCH) {
        batches.push([projectId, queue.slice(i, i + REPORT_BATCH)]);
      }
    }
    this.queues.clear();
    await Promise.all(
      batches.map(([projectId, events]) =>
        this.send(
          `${this.apiUrl}/public/mcp/${encodeURIComponent(projectId)}/events`,
          JSON.stringify({ events }),
        ).catch(() => undefined),
      ),
    );
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
