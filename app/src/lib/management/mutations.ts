import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  cancelManagementEnrollment,
  startManagementEnrollment,
} from "@/lib/api/generated/copilotkit-management/copilotkit-management";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { managementKeys } from "./queries";

const FALLBACK = "Couldn't change managed updates";

function invalidateManagement(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: managementKeys.all });
}

/**
 * Start connecting: the server asks CopilotKit's management service for a code and waits for its
 * approval on its own. Started again while it is already waiting, the server changes nothing.
 */
export function startManagementMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await startManagementEnrollment(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    // Also after a refusal: the server keeps the not-entitled one, and the screen drops Connect.
    onSettled: () => invalidateManagement(queryClient),
  });
}

/**
 * Stop a connection that is waiting, and forget its code and its one-time token. Once connected it
 * is Disconnect: the server forgets the connection when the agent has stopped reporting in (it was
 * uninstalled), and refuses with a sentence saying why while the agent still reports.
 */
export function cancelManagementMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await cancelManagementEnrollment(
        organizationId(),
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateManagement(queryClient),
  });
}
