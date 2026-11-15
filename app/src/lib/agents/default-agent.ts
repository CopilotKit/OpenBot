import type { AgentProfile } from "./queries";

/**
 * The picked harness, by its id in the install package. A Bot says which package Bot it is in
 * `packageBotId`: its own id in the first organization, and still this on another organization's
 * copy, whose own id is generated.
 */
export const PICKED_HARNESS_AGENT_ID = "picked-harness";

export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  return (
    agents?.find(
      (candidate) => candidate.packageBotId === PICKED_HARNESS_AGENT_ID,
    ) ??
    fallback ??
    agents?.[0]
  );
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
