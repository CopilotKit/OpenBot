import type { RunAgentInput } from "@ag-ui/core";

export type CodexTurnInput = {
  developerInstructions: string;
  prompt: string;
};

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
