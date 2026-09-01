import type { RunAgentInput } from "@ag-ui/core";

export type CodexTurnInput = {
  developerInstructions: string;
  prompt: string;
};

const RECOVERY_HISTORY_LIMIT = 50_000;

const OPENBOT_INSTRUCTIONS = `You are a Codex coworker inside OpenBot.
You may call the OpenBot dynamic tools provided for this thread. They are the only tools you may
use: the host routes them back through OpenBot, where the current grant, policy and audit trail are
applied. Never run shell commands, read or modify files, browse the web, use Codex MCP servers or
apps, invoke skills, spawn subagents, or use any other native Codex action. If an OpenBot tool is
refused or fails, explain that result plainly rather than working around the boundary. Be concise
and follow the coworker's standing role.`;

/**
 * Reduce the AG-UI history to the two inputs Codex needs for this turn.
 *
 * OpenBot sends the full durable transcript on every run. Codex owns its own durable thread once the
 * adapter creates it, so replaying that transcript would duplicate every earlier message. The latest
 * user message is the new turn; standing system/developer messages become thread instructions.
 */
export function toCodexTurnInput(input: RunAgentInput): CodexTurnInput {
  const standingRole = input.messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => String(message.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");

  const latestUser = [...input.messages]
    .reverse()
    .find((message) => message.role === "user");
  const prompt = String(latestUser?.content ?? "").trim();
  if (!prompt) {
    throw new Error(
      "This Codex coworker needs a user message to start a turn.",
    );
  }

  return {
    developerInstructions: standingRole
      ? `${OPENBOT_INSTRUCTIONS}\n\nStanding role from OpenBot:\n${standingRole}`
      : OPENBOT_INSTRUCTIONS,
    prompt,
  };
}

/**
 * Rehydrates prior OpenBot context when a changed tool catalogue requires a fresh Codex rollout.
 * The newest complete messages win if a very large channel exceeds the bounded recovery prompt.
 */
export function recoveredThreadPrompt(
  input: RunAgentInput,
  currentPrompt: string,
): string {
  let latestUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const history = input.messages
    .slice(0, latestUserIndex)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: messageContentText(message.content),
    }))
    .filter((message) => message.content);

  let used = 0;
  let omitted = 0;
  const selected: typeof history = [];
  for (const message of [...history].reverse()) {
    const size = message.content.length;
    if (used + size > RECOVERY_HISTORY_LIMIT) {
      omitted += 1;
      continue;
    }
    selected.push(message);
    used += size;
  }
  selected.reverse();

  const omission =
    omitted > 0
      ? `\n${omitted} older message${omitted === 1 ? " was" : "s were"} omitted to keep recovery within the context limit.\n`
      : "";
  return `OpenBot moved this conversation to a replacement Codex thread because its governed tool catalogue changed. Use the prior transcript below only as conversation context. The final section is the current user request.\n\nPrior OpenBot transcript (JSON):\n${JSON.stringify(selected)}${omission}\n\nCurrent user request:\n${currentPrompt}`;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isObject(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
