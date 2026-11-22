import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { acceptServiceTerms } from "@/lib/api/generated/people/people";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { type ServiceTerms, serviceTermsKeys } from "./queries";

const FALLBACK = "Couldn't save that you agreed. Try again.";

/**
 * Agree to the terms, by the version the person was shown. A version that is no longer current is
 * refused with SERVICE_TERMS_CHANGED, and the screen reads the terms again to show the new one.
 *
 * Either way the terms are read again, with `refetchType: "all"`: the gate reads them through
 * `ensureQueryData`, which takes the cache as it finds it, so a stale "has to agree" would send the
 * person straight back to the terms.
 */
export function acceptServiceTermsMutationOptions(queryClient: QueryClient) {
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: serviceTermsKeys.all,
      refetchType: "all",
    });
  return mutationOptions({
    mutationFn: (version: string): Promise<ServiceTerms> =>
      acceptServiceTerms(
        organizationId(),
        "me",
        { version },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: invalidate,
    onError: invalidate,
  });
}
