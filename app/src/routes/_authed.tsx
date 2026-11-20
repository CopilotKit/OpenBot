import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BotLookProvider } from "../components/agents/bot-look";
import { OpenFromApp } from "../components/desktop/open-from-app";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { CommandMenu } from "../components/navigation/command-menu";
import { NewOrganizationDialog } from "../components/organizations/new-organization-dialog";
import { OrganizationBoundary } from "../components/organizations/organization-boundary";
import { ReportedErrorComponent } from "../lib/error-reporting";
import {
  connectedThroughDesktop,
  signOutThroughDesktop,
} from "../lib/auth/mutations";
import {
  needsOnboarding,
  refusedForNotBeingItsApp,
  signedInUser,
} from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { rememberInvitationLink } from "../lib/organizations/invitation-link";
import { learnShortenedToolNames } from "../lib/plugins/tool-names";
import { SkinAccountSync } from "../skins/account-sync";
import { useActiveSkin } from "../skins/registry";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await signedInUser(context.queryClient);
    if (!user) {
      // An invitation's link is kept while they sign in, and home hands them on to it.
      rememberInvitationLink(location.pathname);
      /*
       * Inside an OpenBot Desktop connected to an OpenBot that runs somewhere else, the desktop app
       * holds the sign-in and this page has none to renew: the web sign-in screen would sign in a
       * window that cannot keep it. The desktop app ends what is left of the sign-in and shows its
       * own setup, where the person signs in again. If it cannot, the sign-in screen is still there.
       */
      if (await connectedThroughDesktop(context.queryClient)) {
        await signOutThroughDesktop().catch(() => undefined);
      }
      throw redirect({ to: "/sign" });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      rememberInvitationLink(location.pathname);
      throw redirect({ to: "/onboarding" });
    }
    // Before any conversation is drawn, so a long-named action's step never shows its cut name.
    await learnShortenedToolNames(context.queryClient);
  },
  /*
   * A browser opened at the address of OpenBot on one computer is refused on the first question,
   * who is signed in: OpenBot answers only its own app there. It is told to open the app instead.
   * Every other failure is the router's own error screen, as it was, and is told to OpenBot
   * (lib/error-reporting.tsx). The refusal is OpenBot answering as it should, and is not.
   */
  errorComponent: (props) =>
    refusedForNotBeingItsApp(props.error) ? (
      <OpenFromApp />
    ) : (
      <ReportedErrorComponent {...props} />
    ),
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    // Built again for each organization the person works in, the conversation that was running too.
    <OrganizationBoundary>
      <CopilotProvider>
        {/*
         * Around everything, the command palette included. It sat outside, so it drew every Bot as a
         * face in the colors of another palette while the sidebar and the Bots list drew its orb.
         */}
        <SkinBotLook>
          <AppHotkeys />
          {/* The skin saved on the account, drawn over the browser's cached one once it loads. */}
          <SkinAccountSync />
          {/* Opened by the personal edition's "OpenBot for Business" entry, from whichever skin draws it. */}
          <TeamFeaturesDialog />
          {/* Opened by New organization in the account menu, for somebody who may create one. */}
          <NewOrganizationDialog />
          {/* The command palette, from Cmd/Ctrl+K and from the skins' menus. */}
          <CommandMenu />
          <Outlet />
        </SkinBotLook>
      </CopilotProvider>
    </OrganizationBoundary>
  ),
});

/** Bots are drawn the way the active skin asks for, on every authed page and in every dialog over one. */
function SkinBotLook({ children }: { children: ReactNode }) {
  return (
    <BotLookProvider value={useActiveSkin().botLook ?? "face"}>
      {children}
    </BotLookProvider>
  );
}
