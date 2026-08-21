import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type Person, peopleKeys } from "./queries";

const FALLBACK = "Could not update that person";

function invalidatePeople(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: peopleKeys.all });
}

export function setPersonRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      role: "admin" | "user";
    }): Promise<Person> =>
      client(`/api/admin/people/${variables.userId}/role`, "person", {
        method: "POST",
        body: { role: variables.role },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidatePeople(queryClient),
  });
}

/**
 * Remove somebody's access, or give it back.
 *
 * One mutation rather than two, because the row is a single decision with two directions and the
 * screen renders the same control either way.
 */
export function setPersonAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      userId: string;
      revoked: boolean;
    }): Promise<Person> =>
      client(`/api/admin/people/${variables.userId}/access`, "person", {
        method: "POST",
        body: { revoked: variables.revoked },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidatePeople(queryClient),
  });
}
