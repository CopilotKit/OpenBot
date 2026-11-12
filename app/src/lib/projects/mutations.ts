import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";
import { type Project, projectKeys } from "./queries";

/**
 * What a write to a folder changes about the two reads the sidebar draws from.
 *
 * Both, every time: the projects read owns the folder and its filing, and the roster read owns each
 * channel's `projectId` — the same fact written in two places, so a move that refetched only one of
 * them would draw a conversation in both sections or in neither.
 */
function refreshSidebar(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: projectKeys.all }),
    queryClient.invalidateQueries({ queryKey: channelKeys.all }),
  ]);
}

export function createProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string): Promise<Project> =>
      client("/api/projects", "project", {
        method: "POST",
        body: { name },
        fallback: "Couldn't create that project.",
      }),
    onSuccess: () => refreshSidebar(queryClient),
  });
}

export function renameProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { projectId: string; name: string }): Promise<Project> =>
      client(`/api/projects/${variables.projectId}`, "project", {
        method: "PATCH",
        body: { name: variables.name },
        fallback: "Couldn't rename that project.",
      }),
    onSuccess: () => refreshSidebar(queryClient),
  });
}

/**
 * Deletes the folder only.
 *
 * The channels inside it are untouched on the server — the filing rows cascade with the project and
 * nothing else does — so the sidebar's next read draws them back under Group or Direct. The roster
 * is refetched for that reason, not because anything about a conversation changed.
 */
export function deleteProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (projectId: string): Promise<void> => {
      await client(`/api/projects/${projectId}`, {
        method: "DELETE",
        fallback: "Couldn't delete that project.",
      });
    },
    onSuccess: () => refreshSidebar(queryClient),
  });
}

/**
 * Files one conversation into a folder of this person's, or takes it out when `projectId` is null.
 *
 * The server refuses a channel the caller is not in and a folder that is not theirs, with the same
 * 404 a conversation they cannot see already answers with, so the row shows the server's sentence
 * rather than guessing which of the two it was.
 */
export function moveChannelToProjectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      projectId: string | null;
    }): Promise<void> => {
      await client(`/api/channels/${variables.channelId}/project`, {
        method: "PATCH",
        body: { projectId: variables.projectId },
        fallback: "Couldn't move that conversation.",
      });
    },
    onSuccess: () => refreshSidebar(queryClient),
  });
}