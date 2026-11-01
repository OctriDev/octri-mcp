import { readEnv, type EnvSource } from "./env.js";

// ─── Credential redaction ──────────────────────────────────────────────────────

/**
 * An API that echoes its credential back (a `/headers` debug route, an error
 * quoting the key it refused) would hand that credential to the agent in the
 * tool result. When the key is the user's own that is a nuisance; when Octri
 * attaches a key the owner stored, it is the owner's key leaking to whoever
 * runs the client. So every text this server returns (results, errors, the
 * approval prompt, a dry run) has the session's credentials taken out first.
 */

/** What a credential is replaced with. */
export const REDACTED = "[redacted]";

/** Variables that hold a secret. The username and the key's header name are not secrets. */
const SECRET_SUFFIXES = ["API_TOKEN", "API_KEY", "API_PASSWORD"] as const;

/**
 * Shorter values are left alone: replacing a four-letter password everywhere
 * it appears would mangle ordinary words and give it away by the gaps.
 */
const MIN_SECRET_LENGTH = 8;

/** The shortest piece of a secret cut off at the end of a truncated body that is still taken out. */
const MIN_PARTIAL_LENGTH = 4;

/** The note `readCapped` in operations.ts appends to a body cut at the size limit. */
const TRUNCATION_NOTE = /\n\(truncated at \d+ bytes\)$/;

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Every form the session's credentials could come back in: as sent, as the
 * Basic header's base64, URL-encoded, and JSON-escaped. Longest first, so a
 * secret that contains another is replaced whole.
 */
export function credentialSecrets(env: EnvSource): string[] {
  const forms = new Set<string>();
  const add = (value: string | undefined) => {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) return;
    forms.add(value);
    forms.add(encodeURIComponent(value));
    forms.add(JSON.stringify(value).slice(1, -1));
  };
  for (const suffix of SECRET_SUFFIXES) add(readEnv(env, suffix)?.trim());

  const username = readEnv(env, "API_USERNAME") ?? "";
  const password = readEnv(env, "API_PASSWORD") ?? "";
  if (username !== "" || password !== "") add(base64(`${username}:${password}`));
  // A basic scheme without a username sends the token as the Basic value as is.
  const token = readEnv(env, "API_TOKEN")?.trim();
  if (token !== undefined && token !== "") add(base64(token));

  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** Takes the start of a secret off the end of `text`, where a size limit cut it. */
function redactCutTail(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    for (let length = secret.length - 1; length >= MIN_PARTIAL_LENGTH; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) return `${text.slice(0, text.length - length)}${REDACTED}`;
    }
  }
  return text;
}

/** `text` with every credential form replaced by {@link REDACTED}. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || text === "") return text;
  const note = TRUNCATION_NOTE.exec(text);
  const head = note === null ? text : text.slice(0, note.index);
  let redacted = head;
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED);
  if (note !== null) redacted = `${redactCutTail(redacted, secrets)}${note[0]}`;
  return redacted;
}
