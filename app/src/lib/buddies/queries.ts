import { queryOptions } from "@tanstack/react-query";
import { listBuddies } from "@/lib/api/generated/buddies/buddies";
import type { Buddy } from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

export type OwnBuddy = Buddy;

export const buddyKeys = {
  all: ["buddies"] as const,
  list: () => ["buddies", "list"] as const,
};

/** How often the list is read again while one of the person's buddies is still being made. */
const WHILE_MAKING_MS = 4000;

/**
 * The buddies the person made, newest first. Read again every few seconds while one is being made,
 * so its poses appear as each clip is finished.
 */
export function ownBuddiesQueryOptions() {
  return queryOptions({
    queryKey: buddyKeys.list(),
    queryFn: async (): Promise<OwnBuddy[]> =>
      (
        await listBuddies(organizationId(), {
          fallback: "Couldn't load your buddies.",
        })
      ).buddies,
    refetchInterval: (query) =>
      query.state.data?.some((buddy) => buddy.status === "generating")
        ? WHILE_MAKING_MS
        : false,
    // A server without buddies yet answers 404: the list is empty, and stock buddies still draw.
    retry: false,
  });
}
