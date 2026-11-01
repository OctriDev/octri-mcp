import { languagesOf, type CodeSandbox, type SandboxBridge, type SandboxJob, type SandboxOutcome, type SandboxWasm } from "./code-sandbox.js";

/**
 * Runs a job in this isolate, with the interpreter's own limits as the only
 * guard. Each interpreter is imported when a script first needs it, so a host
 * missing one language's packages still runs the other.
 */
export async function runJob(wasm: SandboxWasm, job: SandboxJob, bridge: SandboxBridge): Promise<SandboxOutcome> {
  if (job.language === "typescript" && wasm.quickjs !== undefined) {
    const { runTypeScript } = await import("./code-sandbox-js.js");
    return runTypeScript(wasm.quickjs, job, bridge);
  }
  if (job.language === "python" && wasm.python !== undefined) {
    const { runPython } = await import("./code-sandbox-python.js");
    return runPython(wasm.python, job, bridge);
  }
  return { status: "crashed", logs: "", logsTruncated: false, error: `${job.language} is not available on this server.` };
}

/**
 * A sandbox that runs scripts in the calling isolate: a Cloudflare Worker's
 * host. The interpreters stop a script on time and memory themselves; the
 * Worker's own CPU limit is the backstop.
 */
export function inProcessCodeSandbox(wasm: SandboxWasm): CodeSandbox {
  return { languages: languagesOf(wasm), run: (job, bridge) => runJob(wasm, job, bridge) };
}

export type { SandboxWasm };
