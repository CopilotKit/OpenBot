import { queryOptions } from "@tanstack/react-query";
import { getAppTeamGrants } from "@/lib/api/generated/bot-grants/bot-grants";
import { getSkillTeamGrants } from "@/lib/api/generated/skills/skills";
import { organizationId } from "@/lib/api/request";

/**
 * The teams an app or a skill is granted to, as their ids in the order the server keeps them. The
 * people in those teams, or in a team beneath one, may put it on a Bot they own. Only an admin of
 * the organization may read or change them.
 *
 * An id that is not one of the organization's teams is a team deleted since. A screen names it with
 * `teamName` (lib/teams/names.ts) and still lets it be taken off.
 */
export type TeamGrants = string[];

export const teamGrantKeys = {
  all: ["team-grants"] as const,
  app: (appId: string) => ["team-grants", "app", appId] as const,
  skill: (skillId: string) => ["team-grants", "skill", skillId] as const,
};

const FALLBACK = "Couldn't load the teams it's given to. Reload the page.";

/** The teams an app is granted to. `appId` is the app's id, as the list of apps answers it. */
export function appTeamGrantsQueryOptions(appId: string) {
  return queryOptions({
    queryKey: teamGrantKeys.app(appId),
    queryFn: async ({ signal }): Promise<TeamGrants> =>
      (
        await getAppTeamGrants(organizationId(), appId, {
          signal,
          fallback: FALLBACK,
        })
      ).teams,
  });
}

/** The teams a skill is granted to. `skillId` is the skill's slug, the command typed after /. */
export function skillTeamGrantsQueryOptions(skillId: string) {
  return queryOptions({
    queryKey: teamGrantKeys.skill(skillId),
    queryFn: async ({ signal }): Promise<TeamGrants> =>
      (
        await getSkillTeamGrants(organizationId(), skillId, {
          signal,
          fallback: FALLBACK,
        })
      ).teams,
  });
}
