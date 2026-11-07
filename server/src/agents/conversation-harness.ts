import { displayNameFor, HARNESSES } from "@openbot/shared/harnesses";
import { isManagedEndpoint } from "./managed-endpoint";
import type { AgentProfile } from "./profile-types";

export type ConversationHarnessConfig = {
  plan?: "claude" | "chatgpt";
  picked?: { endpoint: URL; image: string; source?: string };
};

/** The configured conversation loop. A built-in Bot on a plan delegates only model calls. */
export function conversationHarnessFor(
  agent: Pick<AgentProfile, "runtimeType" | "endpoint" | "deletedAt">,
  { plan, picked }: ConversationHarnessConfig,
): string | undefined {
  if (agent.deletedAt) return undefined;
  if (agent.runtimeType === "built_in") {
    if (plan === "claude") return "CopilotKit with Claude Agent SDK";
    if (plan === "chatgpt") return "CopilotKit with LangChain";
    return "CopilotKit";
  }
  if (
    !agent.runtimeType ||
    !agent.endpoint ||
    !picked ||
    picked.source === "byo" ||
    !isManagedEndpoint(agent.endpoint, [picked.endpoint])
  ) {
    return undefined;
  }
  const image = picked.image.trim().split("/").at(-1)?.split(/[:@]/, 1)[0];
  const harness = HARNESSES.find(
    (row) =>
      row.image && (row.image === image || `openbot-${row.image}` === image),
  );
  return harness && displayNameFor(harness);
}
