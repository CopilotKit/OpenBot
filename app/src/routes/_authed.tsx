import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  consumePendingAuthReturn,
  savePendingAuthReturn,
  signedInReturnRedirect,
} from "../lib/auth/pending-return";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      if (typeof window !== "undefined") {
        savePendingAuthReturn(location.href, window.sessionStorage);
      }
      throw redirect({ to: "/sign" });
    }
    if (typeof window !== "undefined") {
      const pendingReturn = consumePendingAuthReturn(window.sessionStorage);
      const returnTo = signedInReturnRedirect(location.href, pendingReturn);
      if (returnTo) throw redirect({ href: returnTo });
    }

    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
      <Outlet />
    </CopilotProvider>
  ),
});
