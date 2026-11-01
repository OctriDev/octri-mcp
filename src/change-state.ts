import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ChangesSince } from "./changes.js";
import { readEnv, type EnvSource } from "./env.js";

// ─── The last release this machine's agent saw ─────────────────────────────────
//
// A server on the user's own machine (npm, a bundle) has no Octri account to
// remember what its agent was last served, so it keeps the release number in a
// small file of its own. Best effort throughout: a file that cannot be read or
// written means "nothing known", and the agent is told about recent releases.

/** Entries past this many are dropped, least recently seen first. */
const MAX_ENTRIES = 200;

interface StateFile {
  [key: string]: { release: number; seenAt: string };
}

/** Where the file lives: `<PREFIX>_STATE_DIR`, else the system's per-user state folder. */
export function changeStatePath(env: EnvSource, platform: NodeJS.Platform = process.platform): string {
  const own = readEnv(env, "STATE_DIR")?.trim();
  if (own !== undefined && own !== "") return join(own, "changes.json");
  const home = homedir();
  const base =
    platform === "win32"
      ? (process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"))
      : platform === "darwin"
        ? join(home, "Library", "Application Support")
        : (process.env["XDG_STATE_HOME"] ?? join(home, ".local", "state"));
  return join(base, "octri-mcp", "changes.json");
}

function readState(path: string): StateFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

export interface LocalChangeState {
  since: ChangesSince;
  onSeen: (release: number) => void;
}

/**
 * The release last seen for this project (and group), and how to record the
 * next one. Off, with nothing read or written, when `<PREFIX>_CHANGE_NOTICES`
 * is `0`.
 */
export function localChangeState(
  env: EnvSource,
  key: { projectId: string; group?: string | undefined },
  path: string = changeStatePath(env),
): LocalChangeState | undefined {
  if (readEnv(env, "CHANGE_NOTICES")?.trim() === "0") return undefined;
  const id = `${key.projectId}${key.group !== undefined ? `#${key.group}` : ""}`;
  const entry = readState(path)[id];
  const since = entry !== undefined && Number.isInteger(entry.release) && entry.release >= 0 ? entry.release : null;
  return {
    since,
    onSeen: (release) => {
      try {
        const state = readState(path);
        state[id] = { release, seenAt: new Date().toISOString() };
        const kept = Object.entries(state)
          .sort((a, b) => b[1].seenAt.localeCompare(a[1].seenAt))
          .slice(0, MAX_ENTRIES);
        mkdirSync(dirname(path), { recursive: true });
        // Written beside and renamed over, so two servers starting at once
        // never leave half a file.
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(Object.fromEntries(kept), null, 2));
        renameSync(temporary, path);
      } catch {
        // Not writable (a read-only home, a sandbox): notices fall back to recent releases.
      }
    },
  };
}
