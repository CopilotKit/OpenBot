import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  CancelledAccountDeletion,
  ScheduledAccountDeletion,
} from "@/lib/api/generated/model";
import {
  cancelAccountDeletion,
  requestAccountDeletion,
} from "@/lib/api/generated/people/people";
import { idempotencyKey } from "@/lib/api/request";
import { accountDeletionKeys } from "./queries";

const REQUEST_FALLBACK = "Couldn't delete your account. Try again.";
const CANCEL_FALLBACK = "Couldn't cancel the deletion. Try again.";

/** What the person confirmed with: their email address and the phrase, as they typed them. */
export type AccountDeletionInput = {
  confirmEmail: string;
  confirmPhrase: string;
  /** Delete it now, not after the wait. */
  immediate: boolean;
};

/**
 * Delete the person's account: scheduled for 14 days from now, or now. The server checks the email
 * and the phrase, the sign-in's age and the organizations that block it, and refuses each in its
 * own words. A refusal for an organization reads the deletion again, so the section lists it.
 */
export function requestAccountDeletionMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (
      input: AccountDeletionInput,
    ): Promise<ScheduledAccountDeletion> =>
      requestAccountDeletion(
        {
          confirmEmail: input.confirmEmail.trim(),
          confirmPhrase: input.confirmPhrase.trim(),
          ...(input.immediate ? { immediate: true } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: REQUEST_FALLBACK },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: accountDeletionKeys.all }),
  });
}

/** Cancel a scheduled deletion. The account is the person's again. */
export function cancelAccountDeletionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<CancelledAccountDeletion> =>
      cancelAccountDeletion(
        { "Idempotency-Key": idempotencyKey() },
        { fallback: CANCEL_FALLBACK },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: accountDeletionKeys.all }),
  });
}
