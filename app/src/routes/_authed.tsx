import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  consumePendingAuthReturn,
  savePendingAuthReturn,
  signedInReturnRedirect,
} from "../lib/auth/pending-return";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";

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
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <Outlet />
    </CopilotProvider>
  ),
});
