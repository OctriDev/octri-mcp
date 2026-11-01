import { createInterface } from "node:readline";

import { envName, readEnv, type EnvSource } from "./env.js";

// ─── The OS keychain ───────────────────────────────────────────────────────────

/**
 * `octri-mcp login` keeps the API credential in the operating system's own
 * secret store (macOS Keychain, Windows Credential Manager, the Secret Service
 * on Linux) instead of a plaintext env var in the AI client's config file. At
 * start the server reads it back when the env carries no credential.
 *
 * Env vars still win, and wholly: a config that sets any credential variable
 * uses the env alone, so a token from one place never pairs with a username
 * from the other.
 *
 * The store is `@napi-rs/keyring`, an optional dependency: prebuilt binaries
 * for all three systems and no build step. Where it is missing or the system
 * has no secret store, login says so and env vars work as before.
 */

/** What a stored credential may hold, by variable suffix (`API_KEY` reads as `OCTRI_API_KEY`). */
export const KEYCHAIN_SUFFIXES = ["API_TOKEN", "API_KEY", "API_KEY_HEADER", "API_USERNAME", "API_PASSWORD"] as const;
type KeychainSuffix = (typeof KEYCHAIN_SUFFIXES)[number];

/** The suffixes that make a credential: a header name alone is not one. */
const CREDENTIAL_SUFFIXES: readonly KeychainSuffix[] = ["API_TOKEN", "API_KEY", "API_USERNAME", "API_PASSWORD"];

export interface CredentialStore {
  /** Where entries live, for messages: `octri-mcp` or the customer's package name. */
  service: string;
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
  /** True when there was an entry to remove. */
  remove(account: string): Promise<boolean>;
}

/** The OS keychain under one service name, or null when the optional store cannot load here. */
export async function systemKeychain(service: string): Promise<CredentialStore | null> {
  let keyring: typeof import("@napi-rs/keyring");
  try {
    keyring = await import("@napi-rs/keyring");
  } catch {
    return null;
  }
  const entry = (account: string) => new keyring.Entry(service, account);
  return {
    service,
    read: async (account) => entry(account).getPassword() ?? null,
    write: async (account, value) => {
      entry(account).setPassword(value);
    },
    remove: async (account) => {
      try {
        return entry(account).deletePassword();
      } catch {
        // No entry: nothing to remove.
        return false;
      }
    },
  };
}

export type CredentialSource = "env" | "keychain" | "none";

/** True when the env names any credential, in which case the keychain is not read. */
export function envHasCredential(env: EnvSource): boolean {
  return CREDENTIAL_SUFFIXES.some((suffix) => (readEnv(env, suffix)?.trim() ?? "") !== "");
}

function parseStored(raw: string): Partial<Record<KeychainSuffix, string>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const stored: Partial<Record<KeychainSuffix, string>> = {};
    for (const suffix of KEYCHAIN_SUFFIXES) {
      const value = (parsed as Record<string, unknown>)[suffix];
      if (typeof value === "string" && value !== "") stored[suffix] = value;
    }
    return stored;
  } catch {
    return {};
  }
}

/**
 * The env the server runs on: as given when it names a credential, else with
 * the keychain's credential for `account` added. Never writes to process.env.
 */
export async function withKeychainCredential(
  env: EnvSource,
  account: string,
  store: CredentialStore | null,
): Promise<{ env: EnvSource; source: CredentialSource }> {
  if (envHasCredential(env)) return { env, source: "env" };
  if (store === null) return { env, source: "none" };
  let raw: string | null;
  try {
    raw = await store.read(account);
  } catch (err) {
    // A locked keychain or a Linux box with no Secret Service: carry on without.
    process.stderr.write(`Warning: could not read the system keychain (${err instanceof Error ? err.message : String(err)}).\n`);
    return { env, source: "none" };
  }
  const stored = raw === null ? {} : parseStored(raw);
  if (!CREDENTIAL_SUFFIXES.some((suffix) => stored[suffix] !== undefined)) return { env, source: "none" };
  const vars: NodeJS.ProcessEnv = { ...env.vars };
  for (const [suffix, value] of Object.entries(stored)) vars[envName(env, suffix)] = value;
  return { env: { prefix: env.prefix, vars }, source: "keychain" };
}

// ─── login / logout ────────────────────────────────────────────────────────────

export interface LoginIo {
  /** One answer. `hidden` keeps a secret off the screen. */
  ask(question: string, hidden: boolean): Promise<string>;
  write(text: string): void;
}

/** Questions on the terminal, or answers piped in on stdin (`echo $KEY | octri-mcp login`). */
export function terminalIo(): LoginIo & { close(): void } {
  const input = process.stdin;
  const tty = input.isTTY;
  const rl = createInterface({ input, output: process.stderr, terminal: tty });
  let muted = false;
  // Echo nothing while a secret is typed; the question itself was written before.
  const writable = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = writable._writeToOutput?.bind(rl);
  writable._writeToOutput = (text: string) => {
    if (!muted) original?.(text);
  };
  const lines = tty ? null : rl[Symbol.asyncIterator]();
  return {
    ask: async (question, hidden) => {
      process.stderr.write(question);
      if (lines !== null) {
        const next = await lines.next();
        process.stderr.write("\n");
        return next.done === true ? "" : String(next.value);
      }
      muted = hidden;
      const answer = await new Promise<string>((resolve) => rl.question("", resolve));
      muted = false;
      if (hidden) process.stderr.write("\n");
      return answer;
    },
    write: (text) => process.stderr.write(text),
    close: () => rl.close(),
  };
}

const NO_KEYCHAIN = (prefix: string) =>
  "The system keychain is not available here (the optional @napi-rs/keyring package did not install, " +
  `or this system has no secret store). Set ${prefix}_API_TOKEN, ${prefix}_API_KEY or ${prefix}_API_USERNAME/${prefix}_API_PASSWORD ` +
  "in your MCP client's config instead.\n";

/**
 * Asks for the credential the API's scheme needs and saves it in the keychain.
 * Never takes a secret from the command line, where it would land in the
 * shell's history. Returns the exit code.
 */
export async function runLogin(input: {
  auth: string;
  account: string;
  envPrefix: string;
  store: CredentialStore | null;
  io: LoginIo;
}): Promise<number> {
  const { io, envPrefix: prefix } = input;
  if (input.store === null) {
    io.write(NO_KEYCHAIN(prefix));
    return 1;
  }
  const stored: Partial<Record<KeychainSuffix, string>> = {};
  if (input.auth === "bearer" || input.auth === "oauth2") {
    stored.API_TOKEN = (await io.ask("API token: ", true)).trim();
  } else if (input.auth === "apiKey") {
    stored.API_KEY = (await io.ask("API key: ", true)).trim();
    const header = (await io.ask("Header it goes in [X-API-Key]: ", false)).trim();
    if (header !== "") stored.API_KEY_HEADER = header;
  } else if (input.auth === "basic") {
    stored.API_USERNAME = (await io.ask("Username: ", false)).trim();
    stored.API_PASSWORD = await io.ask("Password: ", true);
  } else {
    io.write("This API takes no credential, so there is nothing to save.\n");
    return 0;
  }
  if (CREDENTIAL_SUFFIXES.some((suffix) => suffix in stored && stored[suffix] === "")) {
    io.write("Nothing entered, so nothing was saved.\n");
    return 1;
  }
  try {
    await input.store.write(input.account, JSON.stringify(stored));
  } catch (err) {
    io.write(`Could not save to the system keychain: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.write(
    `Saved in the system keychain (${input.store.service}). Your MCP client's config needs no ${prefix}_API_* variable now; ` +
      "one set there still wins over the keychain.\n",
  );
  return 0;
}

export async function runLogout(input: { account: string; store: CredentialStore | null; envPrefix: string; io: LoginIo }): Promise<number> {
  if (input.store === null) {
    input.io.write(NO_KEYCHAIN(input.envPrefix));
    return 1;
  }
  const removed = await input.store.remove(input.account);
  input.io.write(removed ? "Removed the credential from the system keychain.\n" : "The system keychain held no credential for this server.\n");
  return 0;
}
