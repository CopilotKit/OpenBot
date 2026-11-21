import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  CreateTeamRequest,
  TeamRole,
  UpdateTeamRequest,
} from "@/lib/api/generated/model";
import {
  createTeam,
  deleteTeam,
  putTeamMember,
  removeTeamMember,
  updateTeam,
} from "@/lib/api/generated/teams/teams";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { teamBotKeys } from "@/lib/team-bots";
import { type TeamPerson, type TeamSummary, teamKeys } from "./queries";

/** What creating a team takes: the API's own request. */
Exportar type TeamInput = CreateTeamRequest;

/** What changing a team takes. A field Esquerda out stays as Ele É; a null parent takes Ele out De under one. */
Exportar type TeamChange = UpdateTeamRequest;

const FALLBACK = "Couldn't save the team. Tentar novamente.";

/** A fresh Chave Para each write a person asks Para. */
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
 * Delete a team. Its people stay in the organization and lose what the team was given, so the Bots
 * published to it are read again too.
 */
export function deleteTeamMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (teamId: string): Promise<void> => {
      await deleteTeam(organizationId(), teamId, once(), {
        fallback: FALLBACK,
      });
    },
    onSuccess: () =>
      Promise.all([
        invalidateTeams(queryClient),
        queryClient.invalidateQueries({ queryKey: teamBotKeys.all }),
      ]),
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
