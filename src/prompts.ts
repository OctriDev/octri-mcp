import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { splitTemplate } from "./chains.js";

// ─── Prompts ───────────────────────────────────────────────────────────────────
//
// Prompt templates the owner writes on the MCP page ("Create a customer and
// invoice them"), served through `prompts/list` and `prompts/get`. A message's
// `{{args.<name>}}` references are filled from the arguments the client sends;
// nothing else can be referenced.
//
// Mirrors `McpPromptManifest` in @octri/shared (this package does not depend on it).

export interface PromptTemplate {
  slug: string;
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
  messages: { role: "user" | "assistant"; text: string }[];
  tags?: string[];
}

/** The `prompts/list` entries. */
export function listPrompts(prompts: PromptTemplate[]) {
  return prompts.map((prompt) => ({
    name: prompt.name,
    ...(prompt.title !== undefined ? { title: prompt.title } : {}),
    ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    arguments: prompt.arguments.map((argument) => ({
      name: argument.name,
      ...(argument.description !== undefined ? { description: argument.description } : {}),
      ...(argument.required === true ? { required: true } : {}),
    })),
  }));
}

/** Fills one message's references. An absent optional argument reads as empty text. */
function fill(text: string, args: Record<string, string>): string {
  return splitTemplate(text)
    .map((part) => {
      if (typeof part === "string") return part;
      const { ref } = part;
      if (ref.root !== "args" || ref.path.length !== 1 || typeof ref.path[0] !== "string") {
        throw new McpError(ErrorCode.InternalError, `The prompt has a reference it cannot fill: {{${part.raw}}}.`);
      }
      return Object.hasOwn(args, ref.path[0]) ? (args[ref.path[0]] ?? "") : "";
    })
    .join("");
}

/** The `prompts/get` result for one prompt, or an MCP error a client can show. */
export function getPrompt(prompts: PromptTemplate[], name: string, args: Record<string, string> = {}) {
  const prompt = prompts.find((p) => p.name === name);
  if (prompt === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  const missing = prompt.arguments
    .filter((argument) => argument.required === true && (args[argument.name] ?? "").trim() === "")
    .map((argument) => argument.name);
  if (missing.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${name} needs ${missing.length === 1 ? "the argument" : "the arguments"} ${missing.join(", ")}.`,
    );
  }
  return {
    ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    messages: prompt.messages.map((message) => ({
      role: message.role,
      content: { type: "text" as const, text: fill(message.text, args) },
    })),
  };
}
