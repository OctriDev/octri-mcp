import { logLine } from "./log.js";

// ─── API client ────────────────────────────────────────────────────────────────

/**
 * A failed Octri API call, phrased for the agent reading it. The status is kept
 * so a caller can tell "you asked for something that isn't there" apart from
 * "the service is down": advice the model can act on either way.
 */
export class ApiError extends Error {
  /**
   * The API's own error code (`error.code` in its JSON body), when it sent one.
   * A 404 for a language the docs aren't published in reads the same as a 404
   * for a wrong slug otherwise, and the two need different advice.
   */
  readonly code: string | undefined;

  constructor(readonly status: number, code?: string) {
    super(
      status === 404
        ? "Not found. Check the slug and projectId: list_endpoints shows what this project actually exposes."
        : status === 429
          ? "Rate limited by the Octri API. Wait a moment and retry."
          : `The Octri API returned HTTP ${status}.`,
    );
    this.name = "ApiError";
    this.code = code;
  }
}

/** `error.code` from an Octri API error body, or undefined for any other body. */
function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined;
    const error: unknown = parsed.error;
    if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Full detail goes to the operator's log. The model gets a sentence it can
    // act on: handing it an internal endpoint and a raw error payload told it
    // nothing about which argument to change, and leaked the API's shape.
    logLine(`Octri API ${res.status} from ${url}: ${body.slice(0, 500)}\n`);
    throw new ApiError(res.status, errorCode(body));
  }

  return res.json() as Promise<T>;
}
