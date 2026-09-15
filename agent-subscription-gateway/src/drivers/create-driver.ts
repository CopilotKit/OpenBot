import type { AgentDriver } from "./agent-driver";
import { ClaudeDriver } from "./claude/claude-driver";
import { CodexDriver } from "./codex/codex-driver";
import { GrokDriver } from "./grok/grok-driver";

export function createDriver(provider: string): AgentDriver {
  if (provider === "codex") return new CodexDriver();
  if (provider === "claude") return new ClaudeDriver();
  if (provider === "grok") return new GrokDriver();
  throw new Error(`Unsupported provider: ${provider}.`);
}
