// ─── API client ────────────────────────────────────────────────────────────────

/**
 * A failed Octri API call, phrased for the agent reading it. The status is kept
 * so a caller can tell "you asked for something that isn't there" apart from
 * "the service is down": advice the model can act on either way.
 */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? "Not found. Check the slug and projectId: list_endpoints shows what this project actually exposes."
        : status === 429
          ? "Rate limited by the Octri API. Wait a moment and retry."
          : `The Octri API returned HTTP ${status}.`,
    );
    this.name = "ApiError";
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
    process.stderr.write(`Octri API ${res.status} from ${url}: ${body.slice(0, 500)}\n`);
    throw new ApiError(res.status);
  }

  return res.json() as Promise<T>;
}
