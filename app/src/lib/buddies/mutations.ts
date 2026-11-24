import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { replaceBotBuddy } from "@/lib/api/generated/bots/bots";
import { createBuddy, deleteBuddy } from "@/lib/api/generated/buddies/buddies";
import type { CreateBuddyRequest } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { buddyKeys } from "./queries";

const once = () => ({ "Idempotency-Key": idempotencyKey() });

/** Choose the buddy the person sees for a Bot: `stock:<id>`, `own:<id>`, or null for automatic. */
export function chooseBotBuddyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { botId: string; buddy: string | null }) =>
      (
        await replaceBotBuddy(
          organizationId(),
          variables.botId,
          { buddy: variables.buddy },
          once(),
          { fallback: "Couldn't change the Bot's buddy. Try again." },
        )
      ).bot,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

/** Make a buddy from a picture. It answers at once, and the list shows it being made. */
export function createBuddyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (body: CreateBuddyRequest) =>
      (
        await createBuddy(organizationId(), body, once(), {
          fallback: "Couldn't start making that buddy. Try again.",
        })
      ).buddy,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: buddyKeys.all }),
  });
}

export function deleteBuddyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (buddyId: string) => {
      await deleteBuddy(organizationId(), buddyId, once(), {
        fallback: "Couldn't delete that buddy. Try again.",
      });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: buddyKeys.all }),
        // A Bot drawn with it goes back to its stock buddy.
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
      ]),
  });
}
