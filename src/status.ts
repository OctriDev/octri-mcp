import type { ChainTool } from "./chains.js";
import type { OperationTool } from "./operations.js";

// ─── Endpoint health from Octri monitoring ─────────────────────────────────────
//
// The owner's uptime checks say which endpoints are failing right now. The
// server reads that so an agent learns of an outage before it calls, and so a
// call that fails during one comes back as "known outage, retry later" rather
// than a raw 5xx it would retry blindly. Never more than the monitor saw: no
// check, a stale check, or a monitor that cannot be reached all mean "nothing
// known", and the call behaves exactly as it would without monitoring.

/** One failing endpoint, as the Octri API reports it. Mirrors `McpEndpointStatus` in @octri/shared. */
export interface EndpointStatus {
  /** `down`: the check fails outright. `degraded`: it answers, but past its latency budget. */
  state: "down" | "degraded";
  /** When the current run of failed checks began. Null when the monitor no longer has it. */
  since: string | null;
  /** The check's last run. */
  checkedAt: string;
  /** When the monitor runs the check again: the earliest it can see a recovery. */
  nextCheckAt: string;
  /** Past this the entry says nothing: the monitor stopped checking. */
  staleAt: string;
  /** What the last check got back, when it got an answer. */
  statusCode: number | null;
  reason: "status" | "timeout" | "unreachable" | "latency";
}

/** The project's endpoint health. Mirrors `McpOutageStatus` in @octri/shared. */
export interface OutageStatus {
  /** False when the owner turned outage warnings off, or monitoring is not connected. */
  enabled: boolean;
  /** False when the monitor could not be reached: nothing is known. */
  available?: boolean;
  generatedAt?: string;
  /** The origin the checks probe. A server calling elsewhere is told nothing. */
  origin?: string;
  /** Set when every monitored endpoint on the origin is failing: the API itself is down. */
  api?: EndpointStatus & { checks: number };
  /** Failing endpoints by operation slug. Healthy ones are left out. */
  operations?: Record<string, EndpointStatus>;
}

/** Where a server reads endpoint health. Resolves null when nothing is known. */
export interface StatusSource {
  read(): Promise<OutageStatus | null>;
}

/** A tool's health: its own check, or the API-wide outage that covers it. */
export interface ToolStatus {
  scope: "endpoint" | "api";
  entry: EndpointStatus;
  /** For a chained tool: the step whose endpoint is failing. */
  step?: OperationTool;
  /** For `api` scope: how many monitored endpoints are failing. */
  checks?: number;
}

const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_CACHE_MAX = 64;
const statusCache = new Map<string, { at: number; status: OutageStatus | null }>();

/**
 * Reads the project's public status endpoint, cached for 30 s per project and
 * shared by every session in the process. A failed read is cached too, so a
 * monitor that is down costs one 2 s wait per half minute, not one per call.
 */
export function httpStatusSource(
  apiUrl: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): StatusSource {
  const key = `${apiUrl} ${projectId}`;
  return {
    async read() {
      const cached = statusCache.get(key);
      if (cached !== undefined && now() - cached.at < STATUS_TTL_MS) return cached.status;
      let status: OutageStatus | null = null;
      try {
        const res = await fetchImpl(`${apiUrl}/public/mcp/${encodeURIComponent(projectId)}/status`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (res.ok) status = readOutageStatus(await res.json());
      } catch {
        status = null;
      }
      if (statusCache.size >= STATUS_CACHE_MAX) {
        const oldest = statusCache.keys().next();
        if (oldest.done !== true) statusCache.delete(oldest.value);
      }
      statusCache.set(key, { at: now(), status });
      return status;
    },
  };
}

/** Drops cached reads. For tests. */
export function clearStatusCache(): void {
  statusCache.clear();
}

const STATES = new Set(["down", "degraded"]);
const REASONS = new Set(["status", "timeout", "unreachable", "latency"]);

function readEntry(raw: unknown): EndpointStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const time = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined);
  const checkedAt = time(e["checkedAt"]);
  const nextCheckAt = time(e["nextCheckAt"]);
  const staleAt = time(e["staleAt"]);
  if (!STATES.has(e["state"] as string) || checkedAt === undefined || nextCheckAt === undefined || staleAt === undefined) {
    return undefined;
  }
  return {
    state: e["state"] as EndpointStatus["state"],
    since: time(e["since"]) ?? null,
    checkedAt,
    nextCheckAt,
    staleAt,
    statusCode: typeof e["statusCode"] === "number" ? e["statusCode"] : null,
    reason: REASONS.has(e["reason"] as string) ? (e["reason"] as EndpointStatus["reason"]) : "status",
  };
}

/** Reads a status payload defensively: anything malformed is left out, never guessed at. */
export function readOutageStatus(raw: unknown): OutageStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["enabled"] !== true) return { enabled: false };
  const status: OutageStatus = { enabled: true, available: r["available"] !== false };
  if (typeof r["origin"] === "string") status.origin = r["origin"];
  if (typeof r["generatedAt"] === "string") status.generatedAt = r["generatedAt"];
  const api = readEntry(r["api"]);
  const apiChecks = (r["api"] as Record<string, unknown> | undefined)?.["checks"];
  if (api !== undefined && typeof apiChecks === "number") status.api = { ...api, checks: apiChecks };
  const ops = r["operations"];
  if (typeof ops === "object" && ops !== null) {
    status.operations = {};
    for (const [slug, value] of Object.entries(ops)) {
      const entry = readEntry(value);
      if (entry !== undefined) status.operations[slug] = entry;
    }
  }
  return status;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether a status says anything about a server calling `baseUrl`: on, the
 * monitor reached, and probing the same origin the server calls. A server whose
 * user pointed it at another host (their own staging, say) is told nothing.
 */
export function statusApplies(status: OutageStatus | null, baseUrl: string): status is OutageStatus {
  if (status === null || !status.enabled || status.available === false) return false;
  const origin = originOf(baseUrl);
  return origin !== undefined && status.origin !== undefined && originOf(status.origin) === origin;
}

const fresh = (entry: EndpointStatus, now: number) => Date.parse(entry.staleAt) > now;

/** One operation's health: its own check, else the API-wide outage. */
export function operationStatus(
  status: OutageStatus | null,
  tool: Pick<OperationTool, "slug">,
  baseUrl: string,
  now: number = Date.now(),
): ToolStatus | undefined {
  if (!statusApplies(status, baseUrl)) return undefined;
  const own = status.operations?.[tool.slug];
  if (own !== undefined && fresh(own, now)) return { scope: "endpoint", entry: own };
  // The API-wide entry covers endpoints with no check of their own: every one
  // the monitor watches is failing, so the host is.
  if (status.api !== undefined && fresh(status.api, now)) {
    return { scope: "api", entry: status.api, checks: status.api.checks };
  }
  return undefined;
}

/** A chained tool's health: down if any step is, else degraded if any step is. */
export function chainStatus(
  status: OutageStatus | null,
  chain: ChainTool,
  baseUrl: string,
  now: number = Date.now(),
): ToolStatus | undefined {
  let worst: ToolStatus | undefined;
  for (const step of chain.steps) {
    const found = operationStatus(status, step.tool, baseUrl, now);
    if (found === undefined) continue;
    if (worst === undefined || (worst.entry.state === "degraded" && found.entry.state === "down")) {
      worst = { ...found, step: step.tool };
    }
  }
  return worst;
}

/** `14:02 UTC`, or with the date when it is not today. */
function when(iso: string, now: number): string {
  const d = new Date(iso);
  const time = `${d.toISOString().slice(11, 16)} UTC`;
  return d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    ? time
    : `${d.toISOString().slice(0, 10)} ${time}`;
}

function lastCheck(entry: EndpointStatus): string {
  switch (entry.reason) {
    case "timeout":
      return "timed out";
    case "unreachable":
      return "could not connect";
    case "latency":
      return "answered past its latency budget";
    default:
      return entry.statusCode !== null ? `got HTTP ${entry.statusCode}` : "failed";
  }
}

/** What fails, in words: this endpoint, a chain's step, or every monitored endpoint. */
function subject(found: ToolStatus): string {
  if (found.scope === "api") {
    const n = found.checks ?? 0;
    return n === 1 ? "The one endpoint Octri monitors on this API" : `All ${n} endpoints Octri monitors on this API`;
  }
  return found.step !== undefined
    ? `Step ${found.step.name} (${found.step.http.method} ${found.step.http.path})`
    : "This endpoint";
}

/**
 * The line put in front of a tool's description while its endpoint is failing,
 * so an agent reading the list knows before it calls.
 */
export function statusNote(found: ToolStatus, now: number = Date.now()): string {
  const { entry } = found;
  const since = entry.since !== null ? ` since ${when(entry.since, now)}` : "";
  const plural = found.scope === "api" && (found.checks ?? 0) !== 1;
  if (entry.state === "degraded") {
    return `[Slow now] ${subject(found)} ${plural ? "have" : "has"} been answering slowly${since}, per Octri monitoring. Expect slow responses.`;
  }
  return (
    `[Failing now] ${subject(found)} ${plural ? "have" : "has"} been failing${since}, per Octri monitoring (last check ${lastCheck(entry)}). ` +
    `Calls are likely to fail until it recovers; the monitor checks again at ${when(entry.nextCheckAt, now)}.`
  );
}

/** The machine-readable twin of `statusNote`, put on the listed tool's `_meta`. */
export const STATUS_META_KEY = "dev.octri/status";

export function statusMeta(found: ToolStatus): Record<string, unknown> {
  return {
    [STATUS_META_KEY]: {
      state: found.entry.state,
      scope: found.scope,
      since: found.entry.since,
      nextCheckAt: found.entry.nextCheckAt,
      ...(found.step !== undefined ? { step: found.step.name } : {}),
    },
  };
}

/** Shortest wait an agent is told: the monitor may already be running its next check. */
const RETRY_FLOOR_MS = 60_000;

/**
 * Whether a failed call is the outage the monitor reported: only a server error
 * or no answer at all, and only while the endpoint is known to be down. A 4xx is
 * about the request, and a degraded endpoint still answers.
 */
export function isKnownOutage(found: ToolStatus | undefined, failureStatus: number | null): boolean {
  if (found === undefined || found.entry.state !== "down") return false;
  return failureStatus === null || failureStatus >= 500;
}

/** The structured result for a call that failed during a known outage. */
export function outageResult(
  found: ToolStatus,
  toolName: string,
  failureStatus: number | null,
  raw: string,
  now: number = Date.now(),
) {
  const { entry } = found;
  const retryAt = new Date(Math.max(Date.parse(entry.nextCheckAt), now + RETRY_FLOOR_MS));
  const retryAfterSeconds = Math.ceil((retryAt.getTime() - now) / 1000);
  const since = entry.since !== null ? ` since ${entry.since}` : "";
  const what =
    found.scope === "api"
      ? `while the whole API is down: ${(found.checks ?? 0) === 1 ? "the one endpoint" : `all ${found.checks ?? 0} endpoints`} Octri monitors on it have been failing${since}`
      : found.step !== undefined
        ? `at step ${found.step.name} (${found.step.http.method} ${found.step.http.path}), whose endpoint has been down${since}`
        : `while its endpoint has been down${since}`;
  const text =
    `Known outage: ${toolName} failed ${what}, per Octri monitoring. ` +
    `This is not a problem with the arguments. Do not retry before ${retryAt.toISOString()} (about ${Math.max(1, Math.round(retryAfterSeconds / 60))} min), ` +
    `when the monitor checks again; tell the user the API is having an outage.\n\n${raw}`;
  return {
    text,
    structured: {
      error: "known_outage",
      tool: toolName,
      scope: found.scope,
      ...(found.step !== undefined ? { step: found.step.name } : {}),
      since: entry.since,
      lastCheckedAt: entry.checkedAt,
      monitorStatusCode: entry.statusCode,
      statusCode: failureStatus,
      retryAfter: retryAt.toISOString(),
      retryAfterSeconds,
    },
  };
}
