import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { UserPermissions } from "./config.js";
import { DEFAULT_ENV_PREFIX } from "./env.js";
import { describeRequest, type OperationTool, type SendGate } from "./operations.js";

/**
 * The same hints for one generated operation tool, read off its HTTP method and
 * the owner's `destructive` flag. Anything that is not a read is destructive
 * unless the owner said otherwise: that is the MCP spec's own default, and the
 * old reading (only DELETE) told every client a PUT that overwrites a record
 * was harmless.
 */
export function operationAnnotations(method: string, destructive?: boolean): Tool["annotations"] {
  const verb = method.toUpperCase();
  const readOnly = isReadMethod(verb);
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : (destructive ?? true),
    idempotentHint: readOnly || verb === "PUT" || verb === "DELETE",
    // Every operation tool calls a third-party API.
    openWorldHint: true,
  };
}

// ─── Permissions ───────────────────────────────────────────────────────────────

/** Mirrors `McpToolPolicy` in @octri/shared, which this package does not depend on. */
export type ToolPolicy = "auto" | "confirm" | "off";

/** The parts of a tool its permission is read from. */
export interface PolicySubject {
  name: string;
  policy?: ToolPolicy | undefined;
  http: { method: string };
}

export function isReadMethod(method: string): boolean {
  const verb = method.toUpperCase();
  return verb === "GET" || verb === "HEAD" || verb === "OPTIONS";
}

/**
 * The owner's published policy for a tool. A payload with none comes from an
 * Octri API that predates permissions; it gets the same default the API would
 * give it now (reads run, everything else asks), never the old run-anything.
 */
export function toolPolicy(tool: PolicySubject): ToolPolicy {
  return tool.policy ?? (isReadMethod(tool.http.method) ? "auto" : "confirm");
}

/** Whether the end user's limits let this tool be listed and called at all. */
export function userAllowsTool(
  tool: PolicySubject,
  permissions: UserPermissions,
): boolean {
  if (toolPolicy(tool) === "off") return false;
  if (permissions.deny.has(tool.name)) return false;
  return !(permissions.readOnly && !isReadMethod(tool.http.method));
}

/** Whether a call must be approved by the person at the client before it is sent. */
export function needsApproval(
  tool: PolicySubject,
  permissions: UserPermissions,
): boolean {
  if (toolPolicy(tool) !== "confirm") return false;
  return !(permissions.allow.has("*") || permissions.allow.has(tool.name));
}

/** True when the client advertised form elicitation, which is how approval is asked. */
export function canAskForApproval(
  capabilities: { elicitation?: { form?: object | undefined; url?: object | undefined } | undefined } | undefined,
): boolean {
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) return false;
  // An empty `elicitation: {}` predates modes and means form.
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/** Appended to an "ask first" tool's description, so the agent expects a no. */
export const APPROVAL_NOTE =
  "\n\nEach call asks the user to approve it first. If they decline, do not retry unless they ask you to.";

// ─── Approval ──────────────────────────────────────────────────────────────────

/** How long a person has to answer an approval prompt. */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * The gate one operation call goes through: a dry run returns the request
 * unsent, an "ask first" tool asks the person at the client, and a tool that
 * needs asking on a client that cannot ask is refused rather than run.
 */
export function sendGate(
  tool: OperationTool,
  permissions: UserPermissions,
  client: {
    capabilities: () => Parameters<typeof canAskForApproval>[0];
    ask: (message: string) => Promise<"accept" | "decline" | "cancel">;
  },
  envPrefix: string = DEFAULT_ENV_PREFIX,
): SendGate {
  return async (request) => {
    if (permissions.dryRun) {
      return {
        ok: true,
        held: "dry_run",
        text: `Dry run: this request was built but not sent.\n\n${describeRequest(request)}`,
      };
    }
    if (!needsApproval(tool, permissions)) return null;

    if (!canAskForApproval(client.capabilities())) {
      return {
        ok: false,
        held: "blocked",
        text:
          `Not sent: ${tool.name} needs the user's approval for each call, and this MCP client cannot ask for it. ` +
          `Tell the user. They can pre-approve it by setting ${envPrefix}_ALLOW_TOOLS=${tool.name} in this server's environment, ` +
          `or use a client that supports MCP elicitation (Claude Code, VS Code).`,
      };
    }

    let answer: "accept" | "decline" | "cancel";
    try {
      answer = await client.ask(
        `Allow ${tool.name} to call your API?\n\n${describeRequest(request)}`,
      );
    } catch (err) {
      return {
        ok: false,
        held: "blocked",
        text: `Not sent: the approval prompt for ${tool.name} did not complete (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    if (answer === "accept") return null;
    return {
      ok: false,
      held: "declined",
      text: `Not sent: the user declined this call to ${tool.name}. Do not retry it unless they ask you to.`,
    };
  };
}
