import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { capabilityChangeKeys } from "./queries";
import type { CapabilityChange } from "./translate";

const FALLBACK = "Couldn't save the changes. Try again.";

/** Where saved changes came from: the sentence the model wrote them from. */
export type CapabilityChangeAuthoring = { source: "english"; text: string };

/**
 * Several switches in one save, with the sentence they were written from. The server refuses them,
 * saying what is wrong, unless every change checks, and saves them together or not at all.
 */
export const saveCapabilityChangesMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: (variables: {
      changes: CapabilityChange[];
      authoring?: CapabilityChangeAuthoring;
    }) =>
      client("/api/admin/enterprise/capabilities/batch", {
        method: "POST",
        body: variables,
        fallback: FALLBACK,
      }),
    /*
     * The switches are the Permissions page's, and a Bot's profile says whether its computer of its
     * own is in effect, decided from its owner's "Isolated Bots" switch, as the one-switch save does.
     */
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: enterpriseKeys.all }),
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        queryClient.invalidateQueries({ queryKey: capabilityChangeKeys.all }),
      ]),
  });
