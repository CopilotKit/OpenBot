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

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
