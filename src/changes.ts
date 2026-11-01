import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// ─── What changed since the agent last connected ──────────────────────────────
//
// Each time the tools an agent is served change (a new SDK release, a publish on
// the MCP page, a docs publish that hides a route), the Octri API records a
// release and the difference from the one before. The manifest carries the
// recent ones. The server works out which of them this agent has not seen, puts
// a short note on each tool they changed, answers `what_changed` with the
// detail, and tells an agent calling a renamed or removed tool where it went,
// so a model working from yesterday's schema stops sending stale arguments.

/** A parameter a release added. Mirrors `McpToolParamAdded` in @octri/shared. */
export interface ToolParamAdded {
  name: string;
  required: boolean;
  type?: string;
}

/** A parameter a release changed, in words. Mirrors `McpToolParamChanged` in @octri/shared. */
export interface ToolParamChanged {
  name: string;
  /** What changed, as an agent reads it: "now required", "type string to integer". */
  change: string;
  breaking: boolean;
}

/** One tool's change in one release. Mirrors `McpToolChange` in @octri/shared. */
export interface ToolChange {
  /** The endpoint slug, or the chained tool's slug. */
  slug: string;
  /** Absent: an operation tool. */
  kind?: "chain";
  /** The tool's name after this release; for a removed tool, the name it had. */
  name: string;
  /**
   * `regrouped` changed nothing but which tool groups the tool is in: it means
   * something only to a server serving one of those groups.
   */
  status: "added" | "removed" | "renamed" | "changed" | "regrouped";
  /** A renamed tool's name before this release. */
  previousName?: string;
  /** Set when an operation moved to another path: the slug it had. */
  previousSlug?: string;
  breaking: boolean;
  params?: { added?: ToolParamAdded[]; removed?: string[]; changed?: ToolParamChanged[] };
  /** A chained tool's steps whose operation changed, by tool name. */
  steps?: string[];
  /** The description changed, which never breaks a call. */
  description?: true;
  /** The tool groups the tool is in after this release (a removed tool: before it). */
  groups?: string[];
  /** Groups the tool joined, or left, in this release. */
  joined?: string[];
  left?: string[];
}

/** One release of the served tools. Mirrors `McpToolRelease` in @octri/shared. */
export interface ToolRelease {
  release: number;
  at: string;
  /** The API version the release serves, when the spec names one. */
  apiVersion?: string;
  tools: ToolChange[];
}

/** The manifest's `changes`. Mirrors `McpToolChanges` in @octri/shared. */
export interface ToolChanges {
  /** The release this manifest is. */
  release: number;
  /** The recent releases, oldest first. The first one may be the baseline, with no changes. */
  history: ToolRelease[];
  /** Older releases exist but were left out of the manifest. */
  truncated?: true;
}

export const WHAT_CHANGED = "what_changed";

/** With nothing known about the agent, it is told about releases this recent. */
export const CHANGE_WINDOW_DAYS = 14;

/** One tool's note, and every note in one listing together: a long list must stay readable. */
export const CHANGE_NOTE_MAX = 200;
export const CHANGE_NOTES_BUDGET = 4_000;

/** The machine-readable twin of a tool's note, put on the listed tool's `_meta`. */
export const CHANGES_META_KEY = "dev.octri/changes";

/** Where an agent's view starts: the last release it saw, or null when nothing is known. */
export type ChangesSince = number | null;

/** A tool's changes since the agent's release, every release folded into one. */
export interface FoldedChange {
  slug: string;
  kind?: "chain";
  /** The tool's name now; for a removed tool, the name the agent knew. */
  name: string;
  status: "added" | "removed" | "renamed" | "changed";
  /** A renamed tool's name as the agent knew it. */
  previousName?: string;
  breaking: boolean;
  releases: number[];
  params: { added: ToolParamAdded[]; removed: string[]; changed: ToolParamChanged[] };
  steps: string[];
  description: boolean;
}

const DAY_MS = 86_400_000;

function keyOf(change: { slug: string; kind?: "chain" }): string {
  return `${change.kind ?? "operation"}:${change.slug}`;
}

/** The releases after `since`; with nothing known, the ones of the last few days. */
export function releasesSince(changes: ToolChanges, since: ChangesSince, now: number = Date.now()): ToolRelease[] {
  if (since !== null) return changes.history.filter((r) => r.release > since);
  const from = now - CHANGE_WINDOW_DAYS * DAY_MS;
  return changes.history.filter((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && at >= from;
  });
}

/**
 * The release a `since` argument names: a release number, or a date (the last
 * release before it). Undefined when it is neither.
 */
export function parseSince(raw: unknown, changes: ToolChanges): number | undefined {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return undefined;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  let before = 0;
  for (const r of changes.history) {
    if (Date.parse(r.at) < at) before = Math.max(before, r.release);
  }
  // Every kept release is after the date: start before the oldest one.
  if (before === 0 && changes.history.length > 0) before = Math.max(changes.history[0]!.release - 1, 0);
  return before;
}

function mergeParams(into: FoldedChange["params"], params: ToolChange["params"]) {
  if (params === undefined) return;
  for (const name of params.removed ?? []) {
    const added = into.added.findIndex((p) => p.name === name);
    // Added and removed within the agent's window: it never saw the parameter.
    if (added !== -1) into.added.splice(added, 1);
    else if (!into.removed.includes(name)) into.removed.push(name);
    into.changed = into.changed.filter((c) => c.name !== name);
  }
  for (const param of params.added ?? []) {
    const removed = into.removed.indexOf(param.name);
    if (removed !== -1) {
      // Removed then added back: to the agent, the same parameter changed.
      into.removed.splice(removed, 1);
      into.changed.push({ name: param.name, change: param.required ? "removed and added back, now required" : "removed and added back", breaking: param.required });
    } else {
      into.added = [...into.added.filter((p) => p.name !== param.name), param];
    }
  }
  for (const change of params.changed ?? []) {
    const added = into.added.find((p) => p.name === change.name);
    // A parameter the agent has never seen is new, however often it changed since.
    if (added !== undefined) continue;
    into.changed.push(change);
  }
}

/**
 * Every change of the given releases, one entry per tool. A tool added and then
 * removed within them is left out: the agent never knew it.
 */
export function foldChanges(releases: readonly ToolRelease[]): FoldedChange[] {
  const folded = new Map<string, FoldedChange>();
  // An operation that moved path shows up under a new slug: keep it one entry.
  const alias = new Map<string, string>();
  for (const release of releases) {
    for (const change of release.tools) {
      if (change.status === "regrouped") continue;
      const previousKey =
        change.previousSlug !== undefined ? keyOf({ slug: change.previousSlug, ...(change.kind !== undefined ? { kind: change.kind } : {}) }) : undefined;
      const ownKey = keyOf(change);
      const key = alias.get(ownKey) ?? (previousKey !== undefined ? (alias.get(previousKey) ?? previousKey) : ownKey);
      if (previousKey !== undefined) alias.set(ownKey, key);
      const entry = folded.get(key);
      if (entry === undefined) {
        const fresh: FoldedChange = {
          slug: change.slug,
          ...(change.kind !== undefined ? { kind: change.kind } : {}),
          name: change.name,
          status: change.status,
          ...(change.status === "renamed" && change.previousName !== undefined ? { previousName: change.previousName } : {}),
          breaking: change.status !== "added" && change.breaking,
          releases: [release.release],
          params: { added: [], removed: [], changed: [] },
          steps: [...(change.steps ?? [])],
          description: change.description === true,
        };
        if (change.status !== "added") mergeParams(fresh.params, change.params);
        folded.set(key, fresh);
        continue;
      }
      entry.releases.push(release.release);
      entry.slug = change.slug;
      for (const step of change.steps ?? []) if (!entry.steps.includes(step)) entry.steps.push(step);
      if (change.description === true) entry.description = true;
      if (change.status === "removed") {
        if (entry.status === "added") {
          folded.delete(key);
          continue;
        }
        entry.name = entry.previousName ?? entry.name;
        delete entry.previousName;
        entry.status = "removed";
        entry.breaking = true;
        entry.params = { added: [], removed: [], changed: [] };
        entry.steps = [];
        continue;
      }
      if (change.status === "added") {
        // Removed and back under the same slug: the agent's tool changed.
        if (entry.status === "removed") {
          const known = entry.name;
          entry.status = change.name === known ? "changed" : "renamed";
          if (entry.status === "renamed") entry.previousName = known;
          entry.name = change.name;
          entry.breaking = entry.status === "renamed" || change.breaking;
        }
        continue;
      }
      if (entry.status === "added") {
        // Still new to the agent: only the name it will see matters.
        entry.name = change.name;
        continue;
      }
      if (change.status === "renamed") {
        const known = entry.previousName ?? entry.name;
        entry.name = change.name;
        if (change.name === known) {
          delete entry.previousName;
          entry.status = "changed";
        } else {
          entry.previousName = known;
          entry.status = "renamed";
        }
      }
      if (change.breaking) entry.breaking = true;
      mergeParams(entry.params, change.params);
    }
  }
  // A rename undone, with nothing else changed, is no change at all.
  return [...folded.values()].filter(
    (c) =>
      c.status !== "changed" ||
      c.params.added.length + c.params.removed.length + c.params.changed.length + c.steps.length > 0 ||
      c.description,
  );
}

/** The parts of a change worth a line, breaking ones first. */
function changeParts(change: FoldedChange): string[] {
  const parts: string[] = [];
  if (change.status === "renamed" && change.previousName !== undefined) parts.push(`renamed from ${change.previousName}`);
  if (change.params.removed.length > 0) parts.push(`removed: ${change.params.removed.join(", ")}`);
  const required = change.params.added.filter((p) => p.required).map((p) => p.name);
  if (required.length > 0) parts.push(`new required: ${required.join(", ")}`);
  for (const c of change.params.changed.filter((c) => c.breaking)) parts.push(`${c.name} ${c.change}`);
  if (change.steps.length > 0) parts.push(`steps changed: ${change.steps.join(", ")}`);
  const optional = change.params.added.filter((p) => !p.required).map((p) => p.name);
  if (optional.length > 0) parts.push(`new optional: ${optional.join(", ")}`);
  for (const c of change.params.changed.filter((c) => !c.breaking)) parts.push(`${c.name} ${c.change}`);
  if (change.description) parts.push("description updated");
  return parts;
}

function tag(change: FoldedChange): string {
  if (change.status === "added") return "[New]";
  return change.breaking ? "[Changed, breaking]" : "[Changed]";
}

const NOTE_TAIL = `Call ${WHAT_CHANGED} for details.`;

/** The short form, when the listing's budget for notes is spent. */
export function shortChangeNote(change: FoldedChange): string {
  return change.status === "added"
    ? `[New] Added since you last connected.`
    : `${tag(change)} Changed since you last connected. ${NOTE_TAIL}`;
}

/** The line put first on a changed tool's description. */
export function changeNote(change: FoldedChange): string {
  if (change.status === "added") return "[New] Added since you last connected.";
  const head = `${tag(change)} Since you last connected: `;
  const room = CHANGE_NOTE_MAX - head.length - NOTE_TAIL.length - 2;
  let body = changeParts(change).join("; ");
  if (body.length > room) body = `${body.slice(0, Math.max(room - 3, 0)).replace(/[;,\s]+\S*$/, "")}...`;
  return `${head}${body}. ${NOTE_TAIL}`;
}

export function changeMeta(change: FoldedChange): Record<string, unknown> {
  return {
    [CHANGES_META_KEY]: {
      status: change.status,
      breaking: change.breaking,
      releases: change.releases,
      ...(change.previousName !== undefined ? { previousName: change.previousName } : {}),
    },
  };
}

/**
 * The listing's notes, keyed by tool name: every note at full length while the
 * budget lasts, then the short form.
 */
export function changeNotes(folded: readonly FoldedChange[]): Map<string, { note: string; change: FoldedChange }> {
  const notes = new Map<string, { note: string; change: FoldedChange }>();
  let spent = 0;
  // Breaking changes first, so the budget goes where a stale call would fail.
  const ordered = [...folded].filter((c) => c.status !== "removed").sort((a, b) => Number(b.breaking) - Number(a.breaking));
  for (const change of ordered) {
    const full = changeNote(change);
    const note = spent + full.length <= CHANGE_NOTES_BUDGET ? full : shortChangeNote(change);
    spent += note.length;
    notes.set(change.name, { note, change });
  }
  return notes;
}

/** The `what_changed` tool, its description summing up what this agent has not seen. */
export function whatChangedTool(folded: readonly FoldedChange[]): Tool {
  const removed = folded.filter((c) => c.status === "removed");
  const changed = folded.length - removed.length;
  const breaking = folded.filter((c) => c.breaking).length;
  const summary =
    folded.length === 0
      ? "No tool changed since you last connected."
      : `Since you last connected: ${changed} tool${changed === 1 ? "" : "s"} changed or added` +
        (removed.length > 0 ? `, ${removed.length} removed (${removed.slice(0, 5).map((c) => c.name).join(", ")}${removed.length > 5 ? ", ..." : ""})` : "") +
        (breaking > 0 ? `; ${breaking} of them can break a call that worked before` : "") +
        ".";
  return {
    name: WHAT_CHANGED,
    description:
      `${summary} Lists the tools that changed in this server's recent releases: renamed, removed, and ` +
      `changed arguments, and whether the change breaks calls that used to work. Call it when a tool says ` +
      `it changed, or before reusing arguments from an earlier conversation.`,
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "A release number like 12, or a date like 2026-10-01. Default: since you last connected.",
        },
        tools: { type: "array", items: { type: "string" }, description: "Only these tools (current or old names)." },
        breakingOnly: { type: "boolean", description: "Only changes that can break a call that worked before." },
      },
    },
    annotations: { title: WHAT_CHANGED, readOnlyHint: true, openWorldHint: false },
  };
}

function detailLines(change: FoldedChange): string[] {
  const lines: string[] = [];
  for (const p of change.params.added) lines.push(`  added: ${p.name} (${p.required ? "required" : "optional"}${p.type !== undefined ? `, ${p.type}` : ""})`);
  if (change.params.removed.length > 0) lines.push(`  removed: ${change.params.removed.join(", ")}`);
  for (const c of change.params.changed) lines.push(`  ${c.name}: ${c.change}${c.breaking ? " (breaking)" : ""}`);
  if (change.steps.length > 0) lines.push(`  steps whose operation changed: ${change.steps.join(", ")}`);
  if (change.description) lines.push("  description updated");
  return lines;
}

function headline(change: FoldedChange): string {
  const label =
    change.status === "renamed" && change.previousName !== undefined
      ? `${change.previousName} -> ${change.name}`
      : change.name;
  const what = [change.status, ...(change.breaking ? ["breaking"] : []), `release ${change.releases.join(", ")}`];
  const tail = change.status === "removed" ? ": no longer offered" : "";
  return `${label} (${what.join(", ")})${tail}`;
}

export interface WhatChangedArgs {
  since?: unknown;
  tools?: unknown;
  breakingOnly?: unknown;
}

/** The answer to `what_changed`: readable text, and the same facts as data. */
export function whatChangedResult(
  changes: ToolChanges,
  args: WhatChangedArgs,
  context: {
    /** The release the session started from; null when nothing is known. */
    sessionSince: ChangesSince;
    /** Names served to someone else but not to this user, never reported. */
    hidden: (name: string) => boolean;
    now?: number;
  },
): { text: string; structured: Record<string, unknown>; isError?: true } {
  let since: ChangesSince = context.sessionSince;
  if (args.since !== undefined && args.since !== "") {
    const parsed = parseSince(args.since, changes);
    if (parsed === undefined) {
      return {
        text: `Error: since takes a release number like ${changes.release} or a date like 2026-10-01.`,
        structured: { error: "invalid_since" },
        isError: true,
      };
    }
    since = parsed;
  }
  const releases = releasesSince(changes, since, context.now);
  const filter = Array.isArray(args.tools)
    ? new Set(args.tools.filter((t): t is string => typeof t === "string" && t !== ""))
    : undefined;
  const folded = foldChanges(releases).filter(
    (c) =>
      !context.hidden(c.name) &&
      (filter === undefined || filter.has(c.name) || (c.previousName !== undefined && filter.has(c.previousName))) &&
      (args.breakingOnly !== true || c.breaking),
  );
  const from = since ?? (releases.length > 0 ? releases[0]!.release - 1 : changes.release);
  const latest = changes.history.find((r) => r.release === changes.release);
  const oldest = changes.history[0]?.release ?? changes.release;
  const cutOff = changes.truncated === true && from < oldest - 1;
  const scope =
    since === null
      ? `in the last ${CHANGE_WINDOW_DAYS} days`
      : context.sessionSince !== null && since === context.sessionSince && (args.since === undefined || args.since === "")
        ? `since release ${since} (when you last connected)`
        : `since release ${since}`;
  const header = `Tool changes ${scope}, up to release ${changes.release}${latest?.apiVersion !== undefined ? ` (API ${latest.apiVersion})` : ""}:`;
  const lines =
    folded.length === 0
      ? [`No ${args.breakingOnly === true ? "breaking " : ""}changes${filter !== undefined ? " to those tools" : ""} ${scope}.`]
      : [header, "", ...folded.flatMap((c) => [headline(c), ...detailLines(c)])];
  if (cutOff) lines.push("", `Releases before ${oldest} are not kept by this server; get_changelog has the API's full history.`);
  return {
    text: lines.join("\n"),
    structured: {
      from,
      to: changes.release,
      ...(latest?.apiVersion !== undefined ? { apiVersion: latest.apiVersion } : {}),
      tools: folded,
      ...(cutOff ? { truncated: true } : {}),
    },
  };
}

/**
 * What a call to a tool that is no longer served is told: the tool it became,
 * or that it was removed. Undefined for a name no release ever served.
 */
export function oldNameAnswer(
  changes: ToolChanges,
  name: string,
  current: (name: string) => { inputSchema: unknown } | undefined,
): { text: string; structured: Record<string, unknown> } | undefined {
  // Newest first: the last thing that happened to the name is what counts.
  for (let i = changes.history.length - 1; i >= 0; i -= 1) {
    const release = changes.history[i]!;
    for (const change of release.tools) {
      if (change.status === "renamed" && change.previousName === name) {
        const now = latestName(changes, change, i);
        const tool = now !== undefined ? current(now) : undefined;
        if (now === undefined || tool === undefined) {
          return removedAnswer(name, release.release);
        }
        const required = (tool.inputSchema as { required?: unknown }).required;
        const args = Array.isArray(required) && required.length > 0 ? ` It requires: ${required.join(", ")}.` : "";
        return {
          text:
            `${name} was renamed to ${now} in release ${release.release}. Call ${now} instead; check its arguments ` +
            `before reusing old ones (${WHAT_CHANGED} lists what changed).${args}`,
          structured: { code: "tool_renamed", tool: name, replacement: now, release: release.release },
        };
      }
      if (change.status === "removed" && change.name === name) return removedAnswer(name, release.release);
    }
  }
  return undefined;
}

/** The name a renamed tool has now, following later renames; undefined when it was removed since. */
function latestName(changes: ToolChanges, start: ToolChange, index: number): string | undefined {
  let name = start.name;
  let slug = start.slug;
  for (let i = index + 1; i < changes.history.length; i += 1) {
    for (const change of changes.history[i]!.tools) {
      const same = change.slug === slug || change.previousSlug === slug;
      if (!same || (change.kind ?? "operation") !== (start.kind ?? "operation")) continue;
      if (change.status === "removed") return undefined;
      if (change.status === "renamed" || change.status === "changed" || change.status === "added") {
        name = change.name;
        slug = change.slug;
      }
    }
  }
  return name;
}

function removedAnswer(name: string, release: number) {
  return {
    text: `${name} was removed in release ${release} and is no longer offered. Nothing replaces it by name; look for another tool that does the job.`,
    structured: { code: "tool_removed", tool: name, release },
  };
}

/**
 * The changes a server serving one tool group sees: a tool that joined the
 * group is new to it, one that left is gone, and the rest of the project's
 * tools do not concern it.
 */
export function changesForGroup(changes: ToolChanges, group: string): ToolChanges {
  return {
    ...changes,
    history: changes.history.map((release) => ({
      ...release,
      tools: release.tools.flatMap((change): ToolChange[] => {
        if (change.left?.includes(group) === true) {
          const name = change.status === "renamed" ? (change.previousName ?? change.name) : change.name;
          return [{ slug: change.previousSlug ?? change.slug, ...(change.kind !== undefined ? { kind: change.kind } : {}), name, status: "removed", breaking: true }];
        }
        if (change.joined?.includes(group) === true) {
          return [{ slug: change.slug, ...(change.kind !== undefined ? { kind: change.kind } : {}), name: change.name, status: "added", breaking: false }];
        }
        if (change.status === "regrouped" || change.groups?.includes(group) !== true) return [];
        return [change];
      }),
    })),
  };
}
