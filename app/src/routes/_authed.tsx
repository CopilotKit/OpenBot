import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BotLookProvider } from "../components/agents/bot-look";
import { HeldOutGate } from "../components/auth/company-sign-in-page";
import { OpenFromApp } from "../components/desktop/open-from-app";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { CommandMenu } from "../components/navigation/command-menu";
import { NewOrganizationDialog } from "../components/organizations/new-organization-dialog";
import { OrganizationBoundary } from "../components/organizations/organization-boundary";
import { aiConnectionRequired } from "../lib/ai-connection/queries";
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
import { ReportedErrorComponent } from "../lib/error-reporting";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { onboardingDestination } from "../lib/onboarding/destination";
import { rememberInvitationLink } from "../lib/organizations/invitation-link";
import { learnShortenedToolNames } from "../lib/plugins/tool-names";
import { serviceTermsRequired } from "../lib/service-terms/queries";
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
     * Terms to agree to (OpenBot Cloud), before onboarding and everything else: from anywhere to
     * the terms screen, which remembers where they were headed. The terms screen itself is let
     * through here, past the gates after this one, until they agree.
     */
    if (await serviceTermsRequired(context.queryClient)) {
      if (location.pathname === "/terms") return;
      throw redirect({ to: "/terms", search: { next: location.href } });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     *
     * This gate and the next keep where the person was headed (`?next=`), an invitation's link
     * included, and onboarding's last button takes them there: an app's Reconnect after the move to
     * OpenBot Cloud runs Connect your AI and then opens that app, never home
     * (lib/onboarding/destination.ts).
     */
    const next = onboardingDestination(location.href);
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding", search: next ? { next } : {} });
    }
    /*
     * Where OpenBot provides no AI (OpenBot Cloud), somebody whose runs have none, neither their own
     * nor their organization's, connects their own before anything else: from anywhere, and
     * somebody who finished onboarding before that step existed too. The onboarding route admits
     * them while it holds.
     */
    if (
      location.pathname !== "/onboarding" &&
      (await aiConnectionRequired(context.queryClient))
    ) {
      throw redirect({
        to: "/onboarding",
        search: next ? { step: "ai", next } : { step: "ai" },
      });
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
    // The held page in place of all of it, the moment the organization holds the person out while it is open.
    <HeldOutGate>
      <AuthedApp />
    </HeldOutGate>
  ),
});

function AuthedApp() {
  return (
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
  );
}

/** Bots are drawn the way the active skin asks for, on every authed page and in every dialog over one. */
function SkinBotLook({ children }: { children: ReactNode }) {
  return (
    <BotLookProvider value={useActiveSkin().botLook ?? "face"}>
      {children}
    </BotLookProvider>
  );
}
