// ─── Environment ───────────────────────────────────────────────────────────────

/**
 * Where a server reads its settings and credentials: a prefix and a variable
 * map. `@octri/mcp` reads `OCTRI_API_TOKEN`, `OCTRI_ALLOW_TOOLS` and the rest; a
 * server published under a customer's own name reads `ACME_API_TOKEN` instead,
 * so its users never see the word Octri. The transport variables (`MCP_*`,
 * `PORT`) are the MCP ecosystem's and carry no prefix.
 */
export interface EnvSource {
  prefix: string;
  vars: NodeJS.ProcessEnv;
}

export const DEFAULT_ENV_PREFIX = "OCTRI";

/** The process environment under a prefix (`OCTRI` unless a build says otherwise). */
export function processEnv(prefix: string = DEFAULT_ENV_PREFIX): EnvSource {
  return { prefix, vars: process.env };
}

/** The full variable name for a setting: `envName(env, "API_TOKEN")` is `OCTRI_API_TOKEN`. */
export function envName(env: Pick<EnvSource, "prefix">, suffix: string): string {
  return `${env.prefix}_${suffix}`;
}

export function readEnv(env: EnvSource, suffix: string): string | undefined {
  return env.vars[envName(env, suffix)];
}

const ENABLED = new Set(["1", "true", "yes", "on"]);

/** True when an env flag is set to an affirmative value. */
export function envFlag(value: string | undefined): boolean {
  return value !== undefined && ENABLED.has(value.trim().toLowerCase());
}

/** A comma-separated list, trimmed, empties dropped. */
export function envList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}
