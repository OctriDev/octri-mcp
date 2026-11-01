// ─── Server log ────────────────────────────────────────────────────────────────

/**
 * Writes a line where the host's server log shows it: stderr under Node, which
 * a stdio client keeps apart from the protocol on stdout, and the console in a
 * Cloudflare Worker, whose `process` may carry no stderr stream.
 */
export function logLine(text: string): void {
  const stderr = typeof process === "undefined" ? undefined : (process.stderr as NodeJS.WriteStream | undefined);
  if (stderr !== undefined && typeof stderr.write === "function") {
    stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    return;
  }
  console.error(text.replace(/\n$/, ""));
}
