import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { createOrganization } from "@/lib/api/generated/organizations/organizations";
import { idempotencyKey } from "@/lib/api/request";
import { setCurrentOrganization } from "./current";
import { type OrganizationSummary, organizationKeys, workIn } from "./queries";

const CREATE_FALLBACK = "Couldn't create the organization. Try again.";

/**
 * Work in another of the person's organizations.
 *
 * The server moves the session first, and refuses an organization the person is not in. Then
 * `leave` runs (the caller takes the person home, so no screen of the organization being left is
 * drawn again for the new one), and only then does the app change over: everything it held for the
 * old organization is dropped (query-client.ts) and every screen is drawn again from the new one.
 */
export function switchOrganizationMutationOptions(
  queryClient: QueryClient,
  leave: () => Promise<void> = async () => {},
) {
  return mutationOptions({
    mutationFn: (organizationId: string) => workIn(organizationId),
    onSuccess: async (_done, organizationId) => {
      await leave();
      setCurrentOrganization(organizationId);
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    },
  });
}

/**
 * Create an organization, owned by the person who asked. A refusal is the server's own sentence.
 * The person keeps working where they were: switching to the new one is the caller's next step.
 */
export function createOrganizationMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string): Promise<OrganizationSummary> =>
      (
        await createOrganization(
          { name },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: CREATE_FALLBACK },
        )
      ).organization,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: organizationKeys.all }),
  });
}
