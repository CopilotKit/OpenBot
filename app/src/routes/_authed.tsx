import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { WaitingToasts } from "@/components/notifications/waiting-toasts";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { currentUserQueryOptions } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: RouteComponent,
});

function RouteComponent() {
  /*
   * The socket, and the corner it announces into, belong to the whole signed-in application.
   *
   * Held here rather than in the app shell because a Bot does not stop needing somebody when they
   * walk into Settings. `CopilotProvider` is on this boundary too, so a Bot can be mid-run and ask
   * for help while its person is reading the preferences page, and a socket that only existed
   * alongside the channel rail would mean that ask reached nobody at all: no toast, no marker, no
   * desktop notification, and nothing to recover it afterwards. Settings is also where the desktop
   * notification switch lives, so the page that offers the feature was the page it could not reach.
   *
   * One socket for the application, still. Every screen under here shares this one, and it is the
   * roster query's live patch as well as the notification carrier.
   */
  useChannelEvents();

  return (
    <CopilotProvider>
      <Outlet />
      {/*
       * Fixed to the viewport and outside every screen's scroller, because a Bot waiting for you is
       * not about whichever screen you are on. It takes pointer events only on the cards themselves,
       * so it never covers the thing somebody was in the middle of.
       */}
      <WaitingToasts />
    </CopilotProvider>
  );
}
