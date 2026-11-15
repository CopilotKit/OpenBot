import type { TeamSummary } from "@/lib/teams/queries";

/** What the Teams pages say they are for, in the list's header and in the personal edition. */
export const TEAMS_DESCRIPTION =
  "Put people in teams, then give a team its own Bots.";

/** What a team from the company's directory says about itself, wherever one is drawn. */
export const FROM_DIRECTORY = "From your company's directory";

/** A person's role in a team, as a word. */
export const ROLE_WORDS = {
  maintainer: "Maintainer",
  member: "Member",
} as const;

export function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/**
 * The second line of a team's row: how many people are in it, where it comes from, the team it is
 * under, and the reader's own role in it. Joined with a middle dot, as the People page's rows are.
 */
export function teamFacts(
  team: TeamSummary,
  teams: readonly TeamSummary[],
): string {
  const parent = teams.find((other) => other.id === team.parentTeamId);
  return [
    peopleCount(team.memberCount),
    team.source === "directory" ? FROM_DIRECTORY : null,
    parent ? `Under ${parent.name}` : null,
    team.role === "maintainer"
      ? "You're a maintainer"
      : team.role === "member"
        ? "You're a member"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
