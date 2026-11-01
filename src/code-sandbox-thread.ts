import { parentPort, workerData } from "node:worker_threads";

import { runJob, type SandboxWasm } from "./code-sandbox-wasm.js";
import type { SandboxJob } from "./code-sandbox.js";

// ─── One script, one thread ────────────────────────────────────────────────────
//
// The Node host (code-sandbox-node.ts) starts this file on a worker thread per
// run. It runs the job and relays each SDK call to the parent, which answers
// it through the server. The parent can terminate the thread at any moment,
// so a script the interpreter fails to stop still cannot hold the server.

interface ThreadData {
  wasm: SandboxWasm;
  job: SandboxJob;
}

const port = parentPort;
if (port !== null) {
  const { wasm, job } = workerData as ThreadData;
  const waiting = new Map<number, (answer: string) => void>();
  let next = 0;
  port.on("message", (message: { type: "answer"; id: number; answer: string }) => {
    if (message.type !== "answer") return;
    waiting.get(message.id)?.(message.answer);
    waiting.delete(message.id);
  });
  const bridge = (tool: string, argsJson: string) =>
    new Promise<string>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      port.postMessage({ type: "call", id, tool, argsJson });
    });
  void runJob(wasm, job, bridge).then(
    (outcome) => port.postMessage({ type: "done", outcome }),
    (err: unknown) =>
      port.postMessage({
        type: "done",
        outcome: { status: "crashed", logs: "", logsTruncated: false, error: `The sandbox failed: ${err instanceof Error ? err.message : String(err)}` },
      }),
  );
}
