import type { TeamSummary } from "@/lib/teams/queries";

/**
 * What the Teams pages say they are for, in the list's header and in the personal edition. Read by
 * everybody in the organization, most of whom change nothing here, so it says what a team is.
 */
export const TEAMS_DESCRIPTION =
  "Teams group the people in your organization. A Bot shared with a team is there for everyone in it.";

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
 * under (by `parentName`, once known), and the reader's own role in it. Joined with a middle dot,
 * as the People page's rows are.
 */
export function teamFacts(
  team: TeamSummary,
  parentName: string | undefined,
): string {
  return [
    peopleCount(team.memberCount),
    team.source === "directory" ? FROM_DIRECTORY : null,
    team.parentTeamId !== null && parentName ? `Under ${parentName}` : null,
    team.role === "maintainer"
      ? "You're a maintainer"
      : team.role === "member"
        ? "You're a member"
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
