import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type DemonstrationDraft,
  type DemonstrationRoutine,
  type DemonstrationSummary,
  demonstrationKeys,
} from "./queries";

export type ScheduleDemonstrationInput = {
  cron: string;
  timezone?: string;
  channelId?: string;
  inputs?: string;
};

const path = (id: string) => `/api/demonstrations/${encodeURIComponent(id)}`;

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateDemonstrations(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: demonstrationKeys.all });
}

export function startDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      botId: string;
      title: string;
    }): Promise<DemonstrationSummary> =>
      client("/api/demonstrations", "demonstration", {
        method: "POST",
        body: variables,
        fallback: "Could not start recording",
      }),
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}

export function stopDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`${path(id)}/stop`, {
        method: "POST",
        fallback: "Could not stop recording",
      });
    },
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}

export function draftDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (id: string): Promise<DemonstrationDraft> =>
      client(`${path(id)}/draft`, "draft", {
        method: "POST",
        fallback: "Could not draft a skill",
      }),
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}

export function publishDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      id: string;
      slug: string;
    }): Promise<void> => {
      await client(`${path(variables.id)}/published`, {
        method: "POST",
        body: { slug: variables.slug },
        fallback:
          "The skill was saved, but its demonstration could not be linked",
      });
    },
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}

export function deleteDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(path(id), {
        method: "DELETE",
        fallback: "Could not delete the demonstration",
      });
    },
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}

/** Run the demonstration's saved skill on a schedule, as an ordinary routine. */
export function scheduleDemonstrationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      id: string;
      input: ScheduleDemonstrationInput;
    }): Promise<DemonstrationRoutine> =>
      client(`${path(variables.id)}/schedule`, "routine", {
        method: "POST",
        body: variables.input,
        fallback: "Could not schedule this skill",
      }),
    onSuccess: () => invalidateDemonstrations(queryClient),
  });
}
