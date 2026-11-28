import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  CreateTeamRequest,
  TeamRole,
  UpdateTeamRequest,
} from "@/lib/api/generated/model";
import {
  createTeam,
  deleteTeam,
  deleteTeamModels,
  putTeamMember,
  removeTeamMember,
  replaceTeamModels,
  updateTeam,
} from "@/lib/api/generated/teams/teams";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { modelKeys } from "@/lib/models/queries";
import { teamBotKeys } from "@/lib/team-bots";
import {
  type TeamModelList,
  type TeamPerson,
  type TeamSummary,
  teamKeys,
} from "./queries";

/** What creating a team takes: the API's own request. */
export type TeamInput = CreateTeamRequest;

/** What changing a team takes. A field left out stays as it is; a null parent takes it out from under one. */
export type TeamChange = UpdateTeamRequest;

const FALLBACK = "Couldn't save the team. Try again.";

/** A fresh key for each write a person asks for. */
const once = () => ({ "Idempotency-Key": idempotencyKey() });

const invalidateTeams = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: teamKeys.all });

export function createTeamMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: TeamInput): Promise<TeamSummary> =>
      (
        await createTeam(organizationId(), input, once(), {
          fallback: FALLBACK,
        })
      ).team,
    onSuccess: () => invalidateTeams(queryClient),
  });
}

export function updateTeamMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      teamId: string;
      change: TeamChange;
    }): Promise<TeamSummary> =>
      (
        await updateTeam(
          organizationId(),
          variables.teamId,
          variables.change,
          once(),
          { fallback: FALLBACK },
        )
      ).team,
    onSuccess: () => invalidateTeams(queryClient),
  });
}

/**
 * Whether a cached teams read is about one team: its page, its people or its models
 * (`teamKeys.detail`, `.members`, `.models`, each with the team's id third).
 */
export function aboutTeam(queryKey: readonly unknown[], teamId: string) {
  return queryKey[0] === teamKeys.all[0] && queryKey[2] === teamId;
}

/**
 * Delete a team. Its people stay in the organization and lose what the team was given, so the Bots
 * published to it are read again too, and the models people may pick.
 *
 * NOT THE DELETED TEAM'S OWN READS. Its page is still on screen when the delete answers, and read
 * again it is "Couldn't find that team." until the page leaves, which flashed red for a moment after
 * a delete somebody asked for. They are left as they were, for the page that is leaving, and the
 * caller drops them once it has gone (`forgetTeam`).
 */
export function deleteTeamMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (teamId: string): Promise<void> => {
      await deleteTeam(organizationId(), teamId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: (_data, teamId) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: teamKeys.all,
          predicate: (query) => !aboutTeam(query.queryKey, teamId),
        }),
        queryClient.invalidateQueries({ queryKey: teamBotKeys.all }),
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
      ]),
  });
}

/** Drop a deleted team's reads, once nothing on screen shows them. */
export function forgetTeam(queryClient: QueryClient, teamId: string) {
  queryClient.removeQueries({
    queryKey: teamKeys.all,
    predicate: (query) => aboutTeam(query.queryKey, teamId),
  });
}

/** Put a member of the organization in a team with a role, or change the role of somebody in it. */
export function putTeamMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      teamId: string;
      memberId: string;
      role: TeamRole;
    }): Promise<TeamPerson> =>
      (
        await putTeamMember(
          organizationId(),
          variables.teamId,
          variables.memberId,
          { role: variables.role },
          once(),
          { fallback: FALLBACK },
        )
      ).member,
    onSuccess: () => invalidateTeams(queryClient),
  });
}

const MODELS_FALLBACK = "Couldn't save this team's models. Try again.";

/**
 * A team's models changed: the team's list is read again, and so is the model catalogue, which the
 * server narrows by the reader's teams. An admin in the team sees the composer's picker follow at
 * once, without waiting out the catalogue's five minutes.
 */
const invalidateTeamModels = (queryClient: QueryClient) =>
  Promise.all([
    invalidateTeams(queryClient),
    queryClient.invalidateQueries({ queryKey: modelKeys.all }),
  ]);

/** Set the models a team's people may run. Only an owner or an admin of the organization may. */
export function replaceTeamModelsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      teamId: string;
      models: string[];
    }): Promise<TeamModelList> =>
      replaceTeamModels(
        organizationId(),
        variables.teamId,
        { models: variables.models },
        once(),
        { fallback: MODELS_FALLBACK },
      ),
    onSuccess: () => invalidateTeamModels(queryClient),
  });
}

/** Clear a team's models, so its people run everything the organization allows. Admins only. */
export function deleteTeamModelsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (teamId: string): Promise<void> => {
      await deleteTeamModels(organizationId(), teamId, once(), {
        fallback: MODELS_FALLBACK,
      });
    },
    onSuccess: () => invalidateTeamModels(queryClient),
  });
}

/** Take a person out of a team. Anybody may take themselves out. */
export function removeTeamMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      teamId: string;
      memberId: string;
    }): Promise<void> => {
      await removeTeamMember(
        organizationId(),
        variables.teamId,
        variables.memberId,
        once(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateTeams(queryClient),
  });
}
