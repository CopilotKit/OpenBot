import type { AgentProfile } from "./queries";

export const PICKED_HARNESS_AGENT_ID = "picked-harness";

export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  return (
    agents?.find((candidate) => candidate.id === PICKED_HARNESS_AGENT_ID) ??
    fallback ??
    agents?.[0]
  );
}

/**
 * The Bot a new conversation starts with when the URL names none: the only Bot there is, or the
 * default Bot in the personal edition, whose Bots are all the person's own.
 *
 * FOUND ON WINDOWS: in a fresh personal install with one starter Bot, + opened a conversation with
 * nobody in To:, and a message typed and sent went nowhere until the person picked the only Bot
 * there was. In the team edition with several Bots there is none: a Bot picked on the person's
 * behalf is one they have to notice and remove, so To: starts empty and asks.
 */
export function newConversationAgent(
  agents: readonly AgentProfile[] | undefined,
  edition: "team" | "personal" | undefined,
): AgentProfile | undefined {
  if (agents?.length === 1) return agents[0];
  return edition === "personal" ? defaultAgentProfile(agents) : undefined;
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
