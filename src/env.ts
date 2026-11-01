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

/**
 * A variable's value, or undefined when it is unset or empty. An MCP client
 * config often carries `"OCTRI_API_BASE_URL": ""` for a setting the person
 * left blank; read as a value, it would beat the manifest's base URL, or bind
 * the server to an empty host.
 */
export function envValue(vars: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = vars[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function readEnv(env: EnvSource, suffix: string): string | undefined {
  return envValue(env.vars, envName(env, suffix));
}

/**
 * Drops the settings an MCP Bundle's client passed without a value. A client
 * fills every `${user_config.*}` in the bundle's manifest, so a setting the
 * user left empty arrives as "", and from some clients as the unfilled
 * placeholder. Neither is a value: read as one, "" would send an empty header
 * name or serve a tool group called "".
 */
export function dropUnsetConfig(prefix: string, vars: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith(`${prefix}_`) && (value === "" || value?.startsWith("${user_config.") === true)) {
      delete vars[key];
    }
  }
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
