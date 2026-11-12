import type {
  SidebarSectionId,
  SidebarSections,
  UserPreferences,
} from "@openbot/shared/user-preferences";
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  mergeSidebarSections,
  toggledSidebarSection,
} from "@/lib/channels/sections";
import {
  useUserPreferences,
  userPreferencesQueryOptions,
} from "./message-list";

/**
 * Which sidebar sections this person has folded, saved on their account.
 *
 * The account and not the browser's storage, for the same reason the skin is: a person who folds
 * Projects on their laptop expects it folded on their desktop, and a reload must not change it.
 *
 * The server takes the three flags as one object — the preference row merges a level deeper for
 * exactly this — so every save writes all three. Writing one would replace the others with nothing,
 * and every section somebody had folded would spring open.
 */
export function saveSidebarSectionsMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  const queryKey = userPreferencesQueryOptions(userId).queryKey;
  return mutationOptions({
    mutationFn: (
      sidebarSections: SidebarSections,
    ): Promise<UserPreferences> => {
      if (!userId) throw new Error("Sign in to save your sidebar.");
      return client("/api/settings/preferences", "preferences", {
        method: "PATCH",
        body: { sidebarSections },
        fallback: "Could not save your sidebar",
      });
    },
    /*
     * Folded on the click, not on the reply: a chevron that waits for a round trip reads as a
     * chevron that did not work, and the state it moves to is the one the person just asked for.
     * A failed save puts the section back where it was.
     */
    onMutate: (sidebarSections) => {
      const previous = queryClient.getQueryData(queryKey);
      if (previous)
        queryClient.setQueryData(queryKey, { ...previous, sidebarSections });
      return { previous };
    },
    onError: (_error, _sections, context) => {
      if (context?.previous)
        queryClient.setQueryData(queryKey, context.previous);
    },
    onSuccess: (preferences) => queryClient.setQueryData(queryKey, preferences),
  });
}

export function useSidebarSections() {
  const { userId, data: preferences } = useUserPreferences();
  const queryClient = useQueryClient();
  const save = useMutation(
    saveSidebarSectionsMutationOptions(queryClient, userId),
  );
  const sections = mergeSidebarSections(preferences?.sidebarSections);
  return {
    sections,
    /** Whether a section is folded now, as the account has it. */
    collapsed: (id: SidebarSectionId) => sections[id],
    toggle: (id: SidebarSectionId) =>
      save.mutate(toggledSidebarSection(sections, id)),
    saving: save.isPending,
  };
}
