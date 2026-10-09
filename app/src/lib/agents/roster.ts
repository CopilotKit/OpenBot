import type { AgentProfile } from "./queries";

/**
 * The sections of the Bots roster, from the visible list (`agentListQueryOptions()`).
 *
 * A Bot appears in exactly one section. Pinned wins, and a Team Bot an administrator assigned to the
 * person counts as pinned: it used to sit in their sidebar where they could not hide it, and the top
 * of the roster is where that promise now lives. The rest split on `mine`, never on `canManage`,
 * which is true for an administrator on everybody's Bots.
 */
export function groupRoster(agents: readonly AgentProfile[]): {
  pinned: AgentProfile[];
  yours: AgentProfile[];
  shared: AgentProfile[];
} {
  const isPinned = (agent: AgentProfile) =>
    agent.pinned || agent.assignedToMe === true;
  const rest = agents.filter((agent) => !isPinned(agent));
  return {
    pinned: agents.filter(isPinned),
    yours: rest.filter((agent) => agent.mine),
    shared: rest.filter((agent) => !agent.mine),
  };
}
