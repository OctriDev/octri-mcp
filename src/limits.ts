import { isReadMethod } from "./permissions.js";
import { REDACTED, redactSecrets } from "./redact.js";

// ─── Spending and safety limits ────────────────────────────────────────────────

/**
 * The owner's caps, as the manifest carries them. Mirrors `McpLimitsManifest`
 * in @octri/shared, which this package does not depend on. Absent: no cap.
 */
export interface ToolLimits {
  writesPerSession?: number;
  callsPerMinute?: number;
  /** Per endpoint slug: its own calls per minute, and whether it counts as a write. */
  tools?: Record<string, { perMinute?: number; write?: boolean }>;
  /** Set when the owner keeps an audit log: every attempted write is reported. */
  audit?: true;
}

/** The parts of a tool its limits are read from. */
export interface LimitSubject {
  name: string;
  slug?: string | undefined;
  http: { method: string };
}

/** One minute: the window calls per minute are counted in. */
export const LIMIT_WINDOW_MS = 60_000;

/** Whether a call to this tool counts against the writes cap. */
export function isWriteCall(tool: LimitSubject, limits: ToolLimits | undefined): boolean {
  const own = tool.slug !== undefined ? limits?.tools?.[tool.slug]?.write : undefined;
  return own ?? !isReadMethod(tool.http.method);
}

/** The calls per minute this tool may make, or undefined for no cap. */
export function perMinuteCap(tool: LimitSubject, limits: ToolLimits | undefined): number | undefined {
  const own = tool.slug !== undefined ? limits?.tools?.[tool.slug]?.perMinute : undefined;
  return own ?? limits?.callsPerMinute;
}

/** What a refused call was over. */
export interface LimitHit {
  limit: "writes_per_session" | "calls_per_minute";
  tool: string;
  max: number;
  /** What had been used when it was refused. */
  count: number;
  /** When the window resets, in ms since the epoch; undefined for a session cap, which never resets. */
  resetAtMs?: number;
}

/** A per-minute counter reading. */
export interface WindowCount {
  count: number;
  /** When this window ends, in ms since the epoch. */
  resetAtMs: number;
}

/**
 * Counts calls per tool per minute. The default counts in this process, shared
 * by every session it serves. The hosted server passes one that counts across
 * every instance, so the cap holds for the whole project.
 */
export interface CallLimiter {
  /** The current window's count, without adding to it. */
  peek(projectId: string, slug: string): Promise<WindowCount>;
  /**
   * Adds one call when the window has room under `max`, in one step so two
   * sessions racing cannot both take the last one.
   */
  take(projectId: string, slug: string, max: number): Promise<WindowCount & { allowed: boolean }>;
}

/** Fixed one-minute windows in this process. */
export class MemoryCallLimiter implements CallLimiter {
  private readonly windows = new Map<string, WindowCount>();

  constructor(private readonly now: () => number = Date.now) {}

  private current(projectId: string, slug: string): { key: string; entry: WindowCount } {
    const key = `${projectId}\u0000${slug}`;
    const at = this.now();
    const start = at - (at % LIMIT_WINDOW_MS);
    let entry = this.windows.get(key);
    if (entry === undefined || entry.resetAtMs <= at) {
      entry = { count: 0, resetAtMs: start + LIMIT_WINDOW_MS };
      this.windows.set(key, entry);
      this.sweep(at);
    }
    return { key, entry };
  }

  /** Ended windows are dropped when a new one opens, so the map never grows past the live tools. */
  private sweep(at: number): void {
    if (this.windows.size < 1_024) return;
    for (const [key, entry] of this.windows) if (entry.resetAtMs <= at) this.windows.delete(key);
  }

  peek(projectId: string, slug: string): Promise<WindowCount> {
    const { entry } = this.current(projectId, slug);
    return Promise.resolve({ ...entry });
  }

  take(projectId: string, slug: string, max: number): Promise<WindowCount & { allowed: boolean }> {
    const { entry } = this.current(projectId, slug);
    if (entry.count >= max) return Promise.resolve({ ...entry, allowed: false });
    entry.count += 1;
    return Promise.resolve({ ...entry, allowed: true });
  }
}

/** One per process, shared by every session a self-hosted server opens. */
let processLimiter: MemoryCallLimiter | undefined;
export function processCallLimiter(): CallLimiter {
  processLimiter ??= new MemoryCallLimiter();
  return processLimiter;
}

/**
 * The checks one server session runs before and after the approval prompt.
 * Writes are counted per session here; calls per minute through the limiter.
 */
export class SessionLimits {
  private writes = 0;

  constructor(
    private readonly limiter: CallLimiter,
    private readonly now: () => number = Date.now,
  ) {}

  get writesUsed(): number {
    return this.writes;
  }

  /**
   * Whether these calls would be refused, without counting them: read before
   * the approval prompt, so nobody is asked to approve a call that cannot run.
   * `writes` is how many of them are writes (a chain sends several).
   */
  async check(
    projectId: string,
    tools: readonly LimitSubject[],
    limits: ToolLimits | undefined,
    reportAs: string,
  ): Promise<LimitHit | undefined> {
    if (limits === undefined) return undefined;
    const writes = tools.filter((t) => isWriteCall(t, limits)).length;
    if (limits.writesPerSession !== undefined && writes > 0 && this.writes + writes > limits.writesPerSession) {
      return { limit: "writes_per_session", tool: reportAs, max: limits.writesPerSession, count: this.writes };
    }
    // A tool a chain calls twice needs room for both.
    const perTool = new Map<string, { tool: LimitSubject; calls: number }>();
    for (const tool of tools) {
      const key = tool.slug ?? tool.name;
      const seen = perTool.get(key);
      if (seen !== undefined) seen.calls += 1;
      else perTool.set(key, { tool, calls: 1 });
    }
    for (const [key, { tool, calls }] of perTool) {
      const max = perMinuteCap(tool, limits);
      if (max === undefined) continue;
      const window = await this.limiter.peek(projectId, key);
      if (window.count + calls > max) {
        return { limit: "calls_per_minute", tool: tool.name, max, count: window.count, resetAtMs: window.resetAtMs };
      }
    }
    return undefined;
  }

  /**
   * Counts one call that is about to be sent, or says which limit refuses it.
   * Run after approval, right before the request goes out: another session may
   * have used the room since the check.
   */
  async take(projectId: string, tool: LimitSubject, limits: ToolLimits | undefined): Promise<LimitHit | undefined> {
    if (limits === undefined) return undefined;
    const write = isWriteCall(tool, limits);
    if (write && limits.writesPerSession !== undefined && this.writes >= limits.writesPerSession) {
      return { limit: "writes_per_session", tool: tool.name, max: limits.writesPerSession, count: this.writes };
    }
    const max = perMinuteCap(tool, limits);
    if (max !== undefined) {
      const window = await this.limiter.take(projectId, tool.slug ?? tool.name, max);
      if (!window.allowed) {
        return { limit: "calls_per_minute", tool: tool.name, max, count: window.count, resetAtMs: window.resetAtMs };
      }
    }
    // Counted only once nothing else can refuse it, so a refusal never uses a write.
    if (write) this.writes += 1;
    return undefined;
  }

  /** The `now` the reset times are measured from. */
  clock(): number {
    return this.now();
  }
}

/**
 * What the agent is told when a limit refuses a call: readable text, and the
 * same facts as data, in the shape of the outage and error guide results.
 */
export function limitResult(hit: LimitHit, now: number = Date.now(), step?: string) {
  const resetAt = hit.resetAtMs !== undefined ? new Date(hit.resetAtMs).toISOString() : null;
  const retryAfterSeconds = hit.resetAtMs !== undefined ? Math.max(1, Math.ceil((hit.resetAtMs - now) / 1000)) : null;
  const where = step !== undefined ? ` at step ${step}` : "";
  const text =
    hit.limit === "writes_per_session"
      ? `Not sent: ${hit.tool}${where} would go past this server's limit of ${hit.max} ${hit.max === 1 ? "write" : "writes"} per session ` +
        `(${hit.count} used). The API owner set it. Nothing more will be written in this session: ` +
        `finish with what you have and tell the user, who can start a new session.`
      : `Not sent: ${hit.tool}${where} is limited to ${hit.max} ${hit.max === 1 ? "call" : "calls"} per minute, ` +
        `and ${hit.count} ${hit.count === 1 ? "was" : "were"} made this minute. The API owner set it. ` +
        `Retry after ${resetAt} (about ${retryAfterSeconds} s).`;
  return {
    text,
    structured: {
      error: "limit_reached",
      limit: hit.limit,
      tool: hit.tool,
      ...(step !== undefined ? { step } : {}),
      max: hit.max,
      count: hit.count,
      resetAt,
      retryAfterSeconds,
      hint:
        hit.limit === "writes_per_session"
          ? "Do not retry in this session. Reads still work."
          : `Wait ${retryAfterSeconds} s, then retry. Other tools are not affected.`,
    },
  };
}

// ─── Audit entries ─────────────────────────────────────────────────────────────

/** Longest argument text an audit entry keeps. Mirrors MCP_AUDIT_ARGUMENTS_MAX. */
export const AUDIT_ARGUMENTS_MAX = 4_096;

/** Argument names whose value is a secret whatever it looks like. */
const SECRET_KEY = /pass(word|phrase)?$|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|private[-_]?key|^pin$|^otp$|^cvv$|^cvc$|card[-_]?number/i;

/**
 * A call's arguments as an audit entry keeps them: values under a secret-
 * sounding name and the session's credentials taken out, then cut to size.
 * `sensitive` names the operation's own credential parameters.
 */
export function auditArguments(
  args: Record<string, unknown>,
  secrets: readonly string[],
  sensitive: ReadonlySet<string> = new Set(),
): string | undefined {
  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 8) return REDACTED;
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SECRET_KEY.test(key) || sensitive.has(key) ? REDACTED : scrub(inner, depth + 1);
      }
      return out;
    }
    return value;
  };
  let text: string;
  try {
    text = JSON.stringify(scrub(args, 0)) ?? "";
  } catch {
    return undefined;
  }
  if (text === "" || text === "{}") return undefined;
  text = redactSecrets(text, secrets);
  return text.length > AUDIT_ARGUMENTS_MAX ? `${text.slice(0, AUDIT_ARGUMENTS_MAX - 1)}…` : text;
}

/** Mirrors `McpAuditEvent` in @octri/shared. */
export interface AuditEvent {
  tool: string;
  slug?: string;
  chain?: string;
  group?: string;
  method: string;
  path: string;
  approval: "prompt" | "allow_list" | "auto";
  outcome: "ok" | "error" | "declined" | "blocked" | "limited";
  status?: number;
  durationMs?: number;
  client?: string;
  session?: string;
  arguments?: string;
  at: string;
}
