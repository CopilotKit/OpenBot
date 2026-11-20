import { useMutationState, useQueryClient } from "@tanstack/react-query";
import type { AccountDisconnection } from "@/lib/api/generated/model";
import {
  disconnectBrokeredAccountMutationKey,
  disconnectBrokeredMutationKey,
} from "./mutations";
import { pluginKeys } from "./queries";

/**
 * Whether the person's own connection to this app is being ended, or was, since their connections
 * were last read.
 *
 * An app's page stays up, drawing the account, until the list of connections comes back without
 * it. A read of the connection in that moment asks for one that is gone and is answered 404. So
 * from the moment a disconnect of this app is on its way, until the list has been read again, its
 * own reads are not made: the disconnect drops what they read (`forgetEndedConnection`), and
 * nothing here asks again. Once the list is newer than the disconnect it decides, as always; a
 * connection made again afterwards is read as usual.
 */
export function useConnectionEnding(serverId: string): boolean {
  const queryClient = useQueryClient();
  const ending = useMutationState({
    filters: {
      predicate: (mutation) => {
        const { status, variables, data } = mutation.state;
        const key = JSON.stringify(mutation.options.mutationKey);
        if (key === JSON.stringify(disconnectBrokeredMutationKey))
          return (
            (status === "pending" || status === "success") &&
            variables === serverId
          );
        if (key === JSON.stringify(disconnectBrokeredAccountMutationKey))
          return (
            status === "success" &&
            (variables as { serverId?: string } | undefined)?.serverId ===
              serverId &&
            (data as AccountDisconnection | undefined)?.connectionEnded === true
          );
        return false;
      },
    },
    select: (mutation) => mutation.state.submittedAt,
  });
  if (ending.length === 0) return false;
  const listedAt =
    queryClient.getQueryState(pluginKeys.connections())?.dataUpdatedAt ?? 0;
  return ending.some((submittedAt) => submittedAt >= listedAt);
}
