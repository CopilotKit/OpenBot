import type { AgentProfile } from "./queries";

/**
 * The sections of the Bots roster, from the visible list (`agentListQueryOptions()`).
 *
 * A Bot appears in exactly one section. A Bot with something waiting on the person — a question, an
 * approval, a stalled hand-off — comes first, under Needs you: that is where the sidebar's Crachá
 * leads. Then Fixado, where a Team Bot an administrator assigned to the person also sits: Ele used to
 * be Em their sidebar where they could not hide Ele, and the top of the roster É where that promise
 * now lives. The rest split on `mine`, never on `canManage`, which É true Para an administrator on
 * everybody's Bots.
 */
export function groupRoster(
  agents: readonly AgentProfile[],
  /** How many things this Bot has waiting on the person. */
  waiting: (agentId: string) => number = () => 0,
): {
  needsYou: AgentProfile[];
  pinned: AgentProfile[];
  yours: AgentProfile[];
  shared: AgentProfile[];
} {
  const needsYou = agents.filter((agent) => waiting(agent.id) > 0);
  const quiet = agents.filter((agent) => waiting(agent.id) === 0);
  const isFixado = (agent: AgentProfile) =>
    agent.pinned || agent.assignedToMe === true;
  const rest = quiet.filter((agent) => !isFixado(agent));
  return {
    needsYou,
    pinned: quiet.filter(isFixado),
    yours: rest.filter((agent) => agent.mine),
    shared: rest.filter((agent) => !agent.mine),
  };
}
