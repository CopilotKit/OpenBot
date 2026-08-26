import type { QueryClient } from "@tanstack/react-query";
import { mutationOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { attentionKeys } from "./queries";

/** Who handled it and when, echoed back so the second presser learns who got there first. */
export type AttentionResolution = {
  auditEventId: string;
  resolvedBy: string;
  resolvedAt: string;
};

export function resolveAttentionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (eventId: string): Promise<AttentionResolution> =>
      client(
        `/api/attention/${encodeURIComponent(eventId)}/resolve`,
        "resolution",
        {
          method: "POST",
          fallback: "The item could not be marked handled.",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: attentionKeys.all }),
  });
}
