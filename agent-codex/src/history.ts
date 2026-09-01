import type { RunAgentInput } from "@ag-ui/core";

export type CodexTurnInput = {
  developerInstructions: string;
  prompt: string;
};

const SPIKE_INSTRUCTIONS = `You are a Codex coworker inside a local OpenBot compatibility test.
Respond with text only. Do not run shell commands, modify files, browse the web, use MCP servers,
invoke apps, spawn subagents, or call tools. The host intentionally does not expose those actions
during this first compatibility test. Be concise and follow the coworker's standing role.`;

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
      ? `${SPIKE_INSTRUCTIONS}\n\nStanding role from OpenBot:\n${standingRole}`
      : SPIKE_INSTRUCTIONS,
    prompt,
  };
}
