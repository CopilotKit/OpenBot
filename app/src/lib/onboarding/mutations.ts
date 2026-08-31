import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { authKeys, type OnboardingStatus } from "@/lib/auth/queries";
import { channelKeys } from "@/lib/channels/queries";
import { client } from "@/lib/client";

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Onboarding could not be saved";

/**
 * The status lives on the current user, so that is what a write refreshes.
 *
 * No `onboardingKeys` on purpose: a key nothing reads would be a cache entry nothing invalidates.
 * The `_authed` gate and the wizard both read `currentUserQueryOptions`.
 *
 * `refetchType: "all"`, because nothing may be observing that query: the gate reads it through
 * `ensureQueryData`, which takes the cache as it finds it. The default only refetches active
 * queries, so completing onboarding left a stale "not onboarded" user behind and the gate bounced
 * the navigation straight back to the wizard.
 */
function invalidateCurrentUser(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    queryKey: authKeys.currentUser(),
    refetchType: "all",
  });
}

export function advanceOnboardingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (step: number): Promise<OnboardingStatus> =>
      client("/api/me/onboarding", "onboarding", {
        method: "POST",
        body: { step },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateCurrentUser(queryClient),
  });
}

export function completeOnboardingMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (): Promise<OnboardingStatus> =>
      client("/api/me/onboarding", "onboarding", {
        method: "POST",
        body: { completed: true },
        fallback: FALLBACK,
      }),
    /*
     * The roster too, not just the user: finishing the wizard navigates straight into the app, and
     * a channel list cached from before it — or mid-fetch while the wizard held the screen — lands
     * the person on an empty sidebar their reload then fixes. `refetchType: "all"` for the same
     * reason as the user: nothing is observing these queries while the wizard is up.
     */
    onSuccess: () =>
      Promise.all([
        invalidateCurrentUser(queryClient),
        queryClient.invalidateQueries({
          queryKey: channelKeys.list(),
          refetchType: "all",
        }),
      ]),
  });
}
