/** A session nobody has used for this long is closed. */
export const HTTP_SESSION_IDLE_MS = 30 * 60_000;
/** Open sessions per process. A new one past this is refused until one closes. */
export const MAX_HTTP_SESSIONS = 256;
