import type { AgentProfile } from "./queries";
import { shownSubtitle } from "./subtitle";

/**
 * The sections of the Bots roster, from the visible list (`agentListQueryOptions()`).
 *
 * A Bot appears in exactly one section. A Bot with something waiting on the person — a question, an
 * approval, a stalled hand-off — comes first, under Needs you: that is where the sidebar's badge
 * leads. Then Pinned, where a Team Bot an administrator assigned to the person also sits: it used to
 * be in their sidebar where they could not hide it, and the top of the roster is where that promise
 * now lives. The rest split on `mine`, never on `canManage`, which is true for an administrator on
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
  const isPinned = (agent: AgentProfile) =>
    agent.pinned || agent.assignedToMe === true;
  const rest = quiet.filter((agent) => !isPinned(agent));
  return {
    needsYou,
    pinned: quiet.filter(isPinned),
    yours: rest.filter((agent) => agent.mine),
    shared: rest.filter((agent) => !agent.mine),
  };
}

export type RosterFilters = {
  query: string;
  scope: "all" | "yours" | "shared" | "pinned";
  sort:
    | "default"
    | "name-asc"
    | "name-desc"
    | "title-asc"
    | "title-desc"
    | "description-asc"
    | "description-desc";
};

/** Filter the complete roster before grouping; never sort React Query's array in place. */
export function filterRoster(
  agents: readonly AgentProfile[],
  { query, scope, sort }: RosterFilters,
): AgentProfile[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = agents.filter((agent) => {
    if (scope === "yours" && !agent.mine) return false;
    if (scope === "shared" && agent.mine) return false;
    if (scope === "pinned" && !agent.pinned && !agent.assignedToMe)
      return false;
    return [agent.name, shownSubtitle(agent.title), agent.roleDescription].some(
      (value) => (value ?? "").toLocaleLowerCase().includes(needle),
    );
  });
  if (sort === "default") return filtered;
  const value = (agent: AgentProfile) =>
    sort.startsWith("name-")
      ? agent.name
      : sort.startsWith("title-")
        ? (shownSubtitle(agent.title) ?? "")
        : (agent.roleDescription ?? "");
  const direction = sort.endsWith("-desc") ? -1 : 1;
  return filtered.sort(
    (a, b) =>
      direction *
      value(a).localeCompare(value(b), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}
