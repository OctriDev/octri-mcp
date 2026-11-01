import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { pythonProgram, typeScriptProgram } from "./code-mode.js";
import { loadSandboxWasm, nodeCodeSandbox } from "./code-sandbox-node.js";
import { inProcessCodeSandbox } from "./code-sandbox-wasm.js";
import { DEFAULT_SANDBOX_LIMITS, type CodeSandbox, type SandboxLimits, type SandboxOutcome } from "./code-sandbox.js";

import type { CodeLanguage, SdkMethod } from "./code-sdk.js";
import type { OperationTool } from "./operations.js";

// The code mode sandboxes on their own: what a script can and cannot reach,
// and how each limit ends a run. Both hosts are covered: Node's worker threads
// and the in-isolate runner a Cloudflare Worker uses.

function tool(name: string): OperationTool {
  return {
    slug: `slug-${name}`,
    name,
    description: name,
    deprecated: false,
    inputSchema: { type: "object", properties: {} },
    http: { method: "GET", path: `/${name}`, pathParams: [], queryParams: [], bodyParams: [], constants: [] },
  };
}

const methods: Record<CodeLanguage, SdkMethod[]> = {
  typescript: [
    { path: "pets.list", tool: tool("listPets") },
    { path: "pets.create", tool: tool("createPet") },
  ],
  python: [
    { path: "pets.list", tool: tool("listPets") },
    { path: "pets.create", tool: tool("createPet"), params: { pet_name: "petName" } },
  ],
};

/** A bridge that answers like the server: listPets returns its arguments, createPet is declined. */
const calls: { tool: string; args: unknown }[] = [];
async function bridge(name: string, argsJson: string): Promise<string> {
  const args = JSON.parse(argsJson) as unknown;
  calls.push({ tool: name, args });
  if (name === "createPet") return JSON.stringify({ ok: false, error: { kind: "declined", message: "The user declined." } });
  if (name === "listPets") return JSON.stringify({ ok: true, data: [{ id: 1, args }] });
  return JSON.stringify({ ok: false, error: { kind: "invalid", message: `${name} is not a method.` } });
}

const fast: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, execMs: 1_000, logBytes: 200, resultBytes: 2_000, memoryBytes: 16 * 1024 * 1024 };

function runner(sandbox: () => CodeSandbox) {
  return (language: CodeLanguage, script: string, limits: SandboxLimits = fast): Promise<SandboxOutcome> => {
    const program = (language === "typescript" ? typeScriptProgram : pythonProgram)(methods[language], script);
    return sandbox().run({ language, ...program, limits }, bridge);
  };
}

let threads: CodeSandbox;
let inline: CodeSandbox;
before(async () => {
  const found = await nodeCodeSandbox();
  assert.ok(found !== undefined, "the Node sandbox loads from dist/");
  threads = found;
  inline = inProcessCodeSandbox(await loadSandboxWasm());
});

for (const [host, sandbox] of [
  ["worker threads", () => threads],
  ["in process", () => inline],
] as const) {
  const run = runner(sandbox);

  describe(`code mode sandbox (${host}): TypeScript`, () => {
    it("runs a script with types, calls the SDK, prints and returns JSON", async () => {
      const out = await run(
        "typescript",
        `interface Pet { id: number }\nconst pets: Pet[] = await client.pets.list({ limit: 2 });\nconsole.log("got", pets.length, { ok: true });\nreturn { first: pets[0] };`,
      );
      assert.equal(out.status, "ok", out.error);
      assert.deepEqual(JSON.parse(out.result!), { first: { id: 1, args: { limit: 2 } } });
      assert.equal(out.logs, 'got 1 {"ok":true}\n');
    });

    it("raises the SDK's error classes for a failed call", async () => {
      const out = await run("typescript", `try { await client.pets.create({}); } catch (e) { return [e.name, e.kind, e instanceof ApiError, e.message]; }`);
      assert.deepEqual(JSON.parse(out.result!), ["ApprovalDeclined", "declined", true, "The user declined."]);
    });

    it("names a missing method and points at describe_sdk", async () => {
      const out = await run("typescript", `return await client.pets.adopt();`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /client\.pets\.adopt does not exist\. Find methods with describe_sdk/);
    });

    it("gives errors in the script's own line numbers", async () => {
      const out = await run("typescript", `const a = 1;\nthrow new Error("boom " + a);`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /^Error: boom 1/);
      assert.match(out.error!, /script\.js:2:/);
      assert.doesNotMatch(out.error!, /script\.js:(3\d|[4-9]\d)/, "no preamble frames");
    });

    it("reports a syntax error with its line", async () => {
      const out = await run("typescript", `const ok = 1;\nconst x: number = ;`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /SyntaxError: .*\(line 2, column \d+\)/);
    });

    it("has no filesystem, process, network, timers or wasm", async () => {
      const out = await run(
        "typescript",
        `return [typeof require, typeof process, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof setTimeout, typeof WebAssembly, typeof std, typeof os, typeof Deno, typeof Bun];`,
      );
      assert.deepEqual(JSON.parse(out.result!), Array(11).fill("undefined"));
    });

    it("fails a huge BigInt at once", async () => {
      const out = await run("typescript", `const x = 10n ** 100000000n; return 1;`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /BigInt is too large/);
    });

    it("cannot import modules", async () => {
      const out = await run("typescript", `const fs = await import("fs"); return typeof fs;`);
      assert.equal(out.status, "error");
      assert.equal(out.result, undefined);
    });

    it("cannot reach the host through the constructor chain", async () => {
      const out = await run(
        "typescript",
        `const F = (() => {}).constructor; const g = F("return this")(); return [typeof g.process, typeof g.require, Object.keys(g).filter((k) => !k.startsWith("__")).sort()];`,
      );
      assert.equal(out.status, "ok", out.error);
      const [proc, req] = JSON.parse(out.result!) as [string, string, string[]];
      assert.equal(proc, "undefined");
      assert.equal(req, "undefined");
    });

    it("keeps prototype pollution inside the run", async () => {
      const out = await run(
        "typescript",
        `Object.prototype.polluted = "yes"; Array.prototype.evil = 1; return JSON.parse('{"__proto__": {"admin": true}, "a": 1}');`,
      );
      assert.equal(out.status, "ok", out.error);
      assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
      assert.equal(([] as unknown as Record<string, unknown>)["evil"], undefined);
      const parsed = JSON.parse(out.result!) as Record<string, unknown>;
      assert.equal(({} as Record<string, unknown>)["admin"], undefined);
      assert.equal(parsed["a"], 1);
      const again = await run("typescript", `return [({}).polluted, [].evil];`);
      assert.deepEqual(JSON.parse(again.result!), [null, null], "a fresh run starts clean");
    });

    it("ends an infinite loop on time", async () => {
      const started = Date.now();
      const out = await run("typescript", `while (true) {}`);
      assert.equal(out.status, "timeout");
      assert.ok(Date.now() - started < 5_000);
    });

    it("ends a loop that catches everything", async () => {
      const out = await run("typescript", `for (;;) { try { while (true) {} } catch (e) {} }`);
      assert.equal(out.status, "timeout");
    });

    it("ends a memory bomb at the memory limit", async () => {
      // 1 MB steps reach 16 MB in ~0.2 s locally (small arrays took 1.2 s, and
      // over 10 s on a slow CI runner); the 10 s limit keeps time out of it.
      const out = await run("typescript", `const a = []; while (true) a.push(new Uint8Array(1 << 20));`, { ...fast, execMs: 10_000 });
      assert.equal(out.status, "memory");
    });

    it("ends runaway recursion", async () => {
      const out = await run("typescript", `function f(n) { return f(n + 1) + 1; } return f(0);`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /stack overflow|RangeError|InternalError/i);
    });

    it("caps printing and refuses a huge result", async () => {
      const printed = await run("typescript", `for (let i = 0; i < 10000; i++) console.log("line " + i); return 1;`);
      assert.equal(printed.status, "ok");
      assert.ok(printed.logs.length <= fast.logBytes);
      assert.equal(printed.logsTruncated, true);
      const big = await run("typescript", `return "x".repeat(100000);`);
      assert.equal(big.status, "error");
      assert.match(big.error!, /return value is over 2000 bytes/);
    });

    it("says when a promise never settles", async () => {
      const out = await run("typescript", `await new Promise(() => {});`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /never settles/);
    });

    it("does not count time waiting on calls", async () => {
      const slow = async (name: string, args: string) => {
        await new Promise((r) => setTimeout(r, 400));
        return bridge(name, args);
      };
      const program = typeScriptProgram(methods.typescript, `for (let i = 0; i < 4; i++) await client.pets.list({}); return "done";`);
      const out = await sandbox().run({ language: "typescript", ...program, limits: { ...fast, execMs: 500 } }, slow);
      assert.equal(out.status, "ok", out.error);
    });
  });

  describe(`code mode sandbox (${host}): Python`, () => {
    it("runs a script, calls the SDK with keyword arguments, prints and returns JSON", async () => {
      calls.length = 0;
      const out = await run("python", `pets = client.pets.list(limit=2)\nprint("got", len(pets))\nreturn {"first": pets[0]}`);
      assert.equal(out.status, "ok", out.error);
      assert.deepEqual(JSON.parse(out.result!), { first: { id: 1, args: { limit: 2 } } });
      assert.equal(out.logs, "got 1\n");
      assert.deepEqual(calls, [{ tool: "listPets", args: { limit: 2 } }]);
    });

    it("maps snake_case keywords to the operation's own argument names", async () => {
      calls.length = 0;
      await run("python", `try:\n    client.pets.create(pet_name="Rex")\nexcept ApprovalDeclined:\n    pass\nreturn 1`);
      assert.deepEqual(calls, [{ tool: "createPet", args: { petName: "Rex" } }]);
    });

    it("raises the SDK's error classes for a failed call", async () => {
      const out = await run("python", `try:\n    client.pets.create(pet_name="x")\nexcept ApprovalDeclined as e:\n    return [e.kind, str(e), isinstance(e, ApiError)]`);
      assert.deepEqual(JSON.parse(out.result!), ["declined", "The user declined.", true]);
    });

    it("gives tracebacks in the script's own line numbers", async () => {
      const out = await run("python", `x = 1\nraise ValueError("bad " + str(x))`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /File "<script>", line 2/);
      assert.match(out.error!, /ValueError: bad 1/);
    });

    it("has no filesystem, OS, JavaScript bridge or clock", async () => {
      const out = await run(
        "python",
        [
          "found = []",
          "for name in ['os', 'js', 'jsffi', 'io', 'sys', 'time', 'socket', 'select', 'machine', 'uctypes', 'micropython']:",
          "    try:",
          "        __import__(name)",
          "        found.append(name)",
          "    except ImportError:",
          "        pass",
          "try:",
          "    open('/etc/passwd')",
          "    found.append('open')",
          "except OSError:",
          "    pass",
          "return found",
        ].join("\n"),
      );
      assert.equal(out.status, "ok", out.error);
      const found = JSON.parse(out.result!) as string[];
      for (const name of ["os", "js", "jsffi", "time", "socket", "select", "machine", "uctypes", "open"]) {
        assert.ok(!found.includes(name), `${name} must not be reachable`);
      }
    });

    it("cannot import from files", async () => {
      const out = await run("python", `import passwd`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /ImportError/);
    });

    it("ends an infinite loop, even one that catches everything", async () => {
      const out = await run("python", `while True:\n    try:\n        pass\n    except:\n        pass`);
      assert.equal(out.status, "timeout");
    });

    it("ends a memory bomb", async () => {
      const out = await run("python", `a = []\nwhile True:\n    a.append("x" * 100000)`);
      assert.equal(out.status, "memory");
    });

    it("ends runaway recursion", async () => {
      const out = await run("python", `def f(n):\n    return f(n + 1)\nreturn f(0)`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /RuntimeError: (maximum recursion depth exceeded|pystack exhausted)/);
    });

    it("overflows instead of growing a huge integer", async () => {
      const out = await run("python", `return 10 ** 100`);
      assert.equal(out.status, "error");
      assert.match(out.error!, /OverflowError/);
    });

    it("caps printing and refuses a huge result", async () => {
      const printed = await run("python", `for i in range(10000):\n    print("line", i)\nreturn 1`);
      assert.equal(printed.status, "ok");
      assert.ok(printed.logs.length <= fast.logBytes);
      assert.equal(printed.logsTruncated, true);
      const big = await run("python", `return "x" * 100000`);
      assert.equal(big.status, "error");
      assert.match(big.error!, /return value is over 2000 bytes/);
    });

    it("starts each run with a fresh interpreter", async () => {
      await run("python", `import json\njson.polluted = 1\nreturn 1`);
      const out = await run("python", `import json\nreturn hasattr(json, "polluted")`);
      assert.equal(out.result, "false");
    });
  });
}

describe("code mode sandbox (worker threads): limits", () => {
  it("refuses a run past its concurrency, and the server keeps serving", async () => {
    const one = await nodeCodeSandbox({ concurrency: 1 });
    const run = runner(() => one!);
    const busy = run("typescript", `while (true) {}`);
    const refused = await run("typescript", `return 1`);
    assert.equal(refused.status, "crashed");
    assert.match(refused.error!, /running 1 scripts already/);
    assert.equal((await busy).status, "timeout");
    assert.equal((await run("typescript", `return 2`)).result, "2");
  });
});
