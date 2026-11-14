import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  restorePersonAccess,
  revokePersonAccess,
  updatePerson,
} from "@/lib/api/generated/people/people";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { type Person, peopleKeys } from "./queries";

const FALLBACK = "Could not update that person";

function invalidatePeople(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: peopleKeys.all });
}

export function setPersonRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      userId: string;
      role: "admin" | "user";
    }): Promise<Person> =>
      (
        await updatePerson(
          ORGANIZATION_ID,
          variables.userId,
          { role: variables.role },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        )
      ).person,
    onSuccess: () => invalidatePeople(queryClient),
  });
}

/**
 * Remove somebody's access, or give it back.
 *
 * One mutation rather than two, because the row is a single decision with two directions and the
 * screen renders the same control either way. The API has an action for each direction.
 */
export function setPersonAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      userId: string;
      revoked: boolean;
    }): Promise<Person> =>
      (
        await (variables.revoked ? revokePersonAccess : restorePersonAccess)(
          ORGANIZATION_ID,
          variables.userId,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        )
      ).person,
    onSuccess: () => invalidatePeople(queryClient),
  });
}
