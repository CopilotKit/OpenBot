import type { TeamSummary } from "./queries";

/** What a rule's team is called when the team it names is no longer one of the organization's. */
export const MISSING_TEAM = "A team that no longer exists";

/**
 * What to call the team a rule names. A rule keeps a team's id, and a person reads its name, so every
 * screen that shows a rule looks the name up in the organization's teams. An id that is not among
 * them is a team that has been deleted since: the rule says so, and can still be removed.
 */
export function teamName(
  teams: readonly Pick<TeamSummary, "id" | "name">[],
  teamId: string,
): string {
  return teams.find((team) => team.id === teamId)?.name ?? MISSING_TEAM;
}
