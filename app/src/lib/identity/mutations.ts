import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { identityKeys } from "./queries";

const UNLINK_FALLBACK = "The account could not be disconnected";

/**
 * A 404 means the link is already gone — removed in another tab, or by a retry after a failed audit
 * write — which is what the person asked for, so it is success rather than an error.
 */
export async function unlinkOutcome(response: Response): Promise<void> {
  if (response.ok || response.status === 404) return;
  const message = await response
    .json()
    .then((body: { error?: unknown }) =>
      typeof body?.error === "string" ? body.error : undefined,
    )
    .catch(() => undefined);
  throw new Error(message ?? UNLINK_FALLBACK);
}

export function unlinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> =>
      unlinkOutcome(
        await tryClient(`/api/identity/links/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: identityKeys.links() }),
  });
}
