import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { replaceAppTeamGrants } from "@/lib/api/generated/bot-grants/bot-grants";
import { replaceSkillTeamGrants } from "@/lib/api/generated/skills/skills";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { type TeamGrants, teamGrantKeys } from "./queries";

const FALLBACK = "Couldn't save the teams it's given to. Try again.";

/** What the server now holds is read again, never guessed from what was sent. */
function invalidateTeamGrants(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: teamGrantKeys.all });
}

/**
 * Grant an app to exactly these teams, taking it from any team left out. An empty list takes it
 * from every team.
 */
export function replaceAppTeamGrantsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      appId: string;
      teams: TeamGrants;
    }): Promise<TeamGrants> =>
      (
        await replaceAppTeamGrants(
          organizationId(),
          variables.appId,
          { teams: variables.teams },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        )
      ).teams,
    onSuccess: () => invalidateTeamGrants(queryClient),
  });
}

/**
 * Grant a skill to exactly these teams, taking it from any team left out. An empty list takes it
 * from every team.
 */
export function replaceSkillTeamGrantsMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      skillId: string;
      teams: TeamGrants;
    }): Promise<TeamGrants> =>
      (
        await replaceSkillTeamGrants(
          organizationId(),
          variables.skillId,
          { teams: variables.teams },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        )
      ).teams,
    onSuccess: () => invalidateTeamGrants(queryClient),
  });
}
