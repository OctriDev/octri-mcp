import { createRequire } from "node:module";

import { DEFAULT_ENV_PREFIX, envFlag, envList, type EnvSource } from "./env.js";

// ─── Config ────────────────────────────────────────────────────────────────────

export const DEFAULT_API_URL = "https://api.octri.dev/api/v1";

/**
 * Reported to the client in the MCP handshake. Read from the manifest rather
 * than pinned in source, where it sat at 1.0.0 for every published release and
 * made the version a client sees meaningless for support or telemetry.
 */
export const SERVER_VERSION = ((): string => {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** How the process is reached: the MCP ecosystem's own variables, unprefixed. */
export interface TransportConfig {
  transport: string;
  port: number;
  /** Interface the SSE transport binds to. Loopback unless deliberately widened. */
  host: string;
  /** Browser origins allowed to reach the SSE transport. Empty means none. */
  allowedOrigins: Set<string>;
  /** Bearer token every HTTP request must carry. Empty means none is asked for. */
  authToken: string;
}

/** Everything the `octri-mcp` command line reads at startup. */
export interface Config extends TransportConfig {
  projectId: string;
  apiUrl: string;
  /** The end user's own limits on top of the owner's published permissions. */
  permissions: UserPermissions;
  /** Report each tool call's name and outcome to Octri. */
  telemetry: boolean;
}

/**
 * What the person running the server allows, on top of what the project owner
 * published. Every field narrows, except `allow`, which pre-approves tools the
 * owner set to ask first. Nothing here can bring back a tool the owner turned off.
 */
export interface UserPermissions {
  /** Tool names that run without asking; "*" pre-approves every one. */
  allow: Set<string>;
  /** Tool names that are never listed or run. */
  deny: Set<string>;
  /** Only tools whose HTTP method reads are listed or run. */
  readOnly: boolean;
  /** Build each API call and return it instead of sending it. */
  dryRun: boolean;
}

/** No limits beyond the owner's: what a server gets when its host sets none. */
export function noUserLimits(): UserPermissions {
  return { allow: new Set(), deny: new Set(), readOnly: false, dryRun: false };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * The end user's limits from the command line and the environment. `env` is
 * either a plain variable map read under the `OCTRI_` prefix (what the tests
 * pass) or an `EnvSource` carrying its own prefix (a branded build).
 */
export function loadUserPermissions(
  args: readonly string[],
  env: NodeJS.ProcessEnv | EnvSource,
): UserPermissions {
  const source: EnvSource = isEnvSource(env) ? env : { prefix: DEFAULT_ENV_PREFIX, vars: env };
  const read = (suffix: string) => source.vars[`${source.prefix}_${suffix}`];
  const allow = envList(flagValue(args, "--allow-tools") ?? read("ALLOW_TOOLS"));
  if (args.includes("--allow-writes") || envFlag(read("ALLOW_WRITES"))) allow.add("*");
  return {
    allow,
    deny: envList(flagValue(args, "--deny-tools") ?? read("DENY_TOOLS")),
    readOnly: args.includes("--read-only") || envFlag(read("READ_ONLY")),
    dryRun: args.includes("--dry-run") || envFlag(read("DRY_RUN")),
  };
}

function isEnvSource(env: NodeJS.ProcessEnv | EnvSource): env is EnvSource {
  return typeof env["prefix"] === "string" && typeof env["vars"] === "object" && env["vars"] !== null;
}

/**
 * The command line's configuration. `--project-id` wins over the environment.
 * A branded build passes its own prefix and API URL default.
 */
export function loadConfig(
  args: readonly string[],
  env: EnvSource,
  defaults: { apiUrl?: string } = {},
): Config {
  const read = (suffix: string) => env.vars[`${env.prefix}_${suffix}`];
  return {
    permissions: loadUserPermissions(args, env),
    telemetry: !args.includes("--no-telemetry") && read("TELEMETRY")?.trim() !== "0",
    projectId: flagValue(args, "--project-id") ?? read("PROJECT_ID") ?? "",
    apiUrl: read("API_URL") ?? defaults.apiUrl ?? DEFAULT_API_URL,
    transport: env.vars["MCP_TRANSPORT"] ?? "stdio",
    port: parseInt(env.vars["PORT"] ?? "3000", 10),
    host: env.vars["MCP_HOST"] ?? "127.0.0.1",
    allowedOrigins: envList(env.vars["MCP_ALLOWED_ORIGINS"]),
    authToken: env.vars["MCP_AUTH_TOKEN"] ?? "",
  };
}
