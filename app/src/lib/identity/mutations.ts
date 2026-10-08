import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { identityKeys } from "./queries";

export function unlinkMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/identity/links/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "The account could not be disconnected",
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: identityKeys.links() }),
  });
}

export function confirmChallengeMutationOptions() {
  return mutationOptions({
    mutationFn: (token: string): Promise<{ hint: string | null }> =>
      client<{ hint: string | null }>(
        "/api/identity/challenges/confirm",
        "confirmation",
        {
          method: "POST",
          body: { token },
          fallback: "This link could not be confirmed",
        },
      ),
  });
}
