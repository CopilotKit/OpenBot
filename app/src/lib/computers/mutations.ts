import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/**
 * Stopping frees the container; resetting also deletes the browser profiles on it; updating moves
 * the computer onto the current image and keeps the profiles.
 */
export type ComputerAction = "stop" | "reset" | "update";

const PAST: Record<ComputerAction, string> = {
  stop: "stopped",
  reset: "reset",
  update: "updated",
};

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

/**
 * An administrator stopping, resetting or updating one computer from the list.
 *
 * Named by whose computer it is, not by a Bot: the computer on the list is somebody else's, and the
 * Bot routes act on the asker's own. `botId` names one seat on a shared computer.
 */
export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      computer: string;
      botId?: string;
      action: ComputerAction;
    }) => {
      await client("/api/computers/fleet", {
        method: "POST",
        body: {
          action: variables.action,
          computer: variables.computer,
          ...(variables.botId ? { botId: variables.botId } : {}),
        },
        fallback: `The computer could not be ${PAST[variables.action]}.`,
      });
    },
    /** A reset deletes the profile those commands ran on; a stop keeps it, so only reset forgets. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset" && variables.botId)
        clearActivity(variables.botId);
      return invalidateComputers(queryClient);
    },
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
