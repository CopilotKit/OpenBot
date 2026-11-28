import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BotLookProvider } from "../components/agents/bot-look";
import { HeldOutGate } from "../components/auth/company-sign-in-page";
import { PendingDeletionGate } from "../components/auth/pending-deletion-page";
import { WebPushKeeper } from "../components/delivery/web-push-keeper";
import { OpenFromApp } from "../components/desktop/open-from-app";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { AppFrameSkeleton } from "../components/layout/app-frame-skeleton";
import { CommandMenu } from "../components/navigation/command-menu";
import { NewOrganizationDialog } from "../components/organizations/new-organization-dialog";
import { OrganizationBoundary } from "../components/organizations/organization-boundary";
import { CardNeededDialog } from "../components/plan/card-needed-dialog";
import { ResumeAccountDeletion } from "../components/settings/delete-account";
import { showPendingDeletion } from "../lib/account-deletion/pending";
import { scheduledDeletion } from "../lib/account-deletion/queries";
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
import { forgetSignedIn, rememberSignedIn } from "../lib/auth/was-signed-in";
import { CopilotProvider } from "../lib/copilot/provider";
import { ReportedErrorComponent } from "../lib/error-reporting";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { standingInWhileLoadingAgain } from "../lib/load-again";
import { onboardingDestination } from "../lib/onboarding/destination";
import { rememberInvitationLink } from "../lib/organizations/invitation-link";
import { learnShortenedToolNames } from "../lib/plugins/tool-names";
import { serviceTermsRequired } from "../lib/service-terms/queries";
import { SkinAccountSync } from "../skins/account-sync";
import { useActiveSkin } from "../skins/registry";

export const Route = createFileRoute("/_authed")({
  /*
   * Convention for every route: a `beforeLoad` or `loader` called with `preload: true` only reads. A hover
   * runs it too, and must not change what the person did not choose, so the writes below wait for the visit.
   */
  beforeLoad: async ({ context, location, preload }) => {
    const user = await signedInUser(context.queryClient);
    if (!user) {
      // A hover on a link must not leave the invitation behind or sign Desktop out; only the visit does.
      if (!preload) {
        // Nobody is signed in any more, so the next visit must not draw the app's frame before the sign-in screen.
        forgetSignedIn();
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
      }
      throw redirect({ to: "/sign" });
    }
    /*
     * The questions the gates below decide on go out together, so the wait is the slowest one and
     * not the sum of them. They are decided in the order they always were: a scheduled deletion,
     * terms, onboarding, the AI connection, then the shortened tool names. A question an earlier gate
     * never reads, because it returned or redirected, must not become an unhandled rejection, so each
     * keeps a handler on a side reference; a failure is still thrown where its gate awaits it.
     */
    const scheduled = scheduledDeletion(context.queryClient);
    const terms = serviceTermsRequired(context.queryClient);
    const ai =
      location.pathname !== "/onboarding" && !needsOnboarding(user)
        ? aiConnectionRequired(context.queryClient)
        : null;
    const toolNames = learnShortenedToolNames(context.queryClient);
    terms.catch(() => undefined);
    ai?.catch(() => undefined);
    toolNames.catch(() => undefined);
    /*
     * An account scheduled to be deleted, before everything else: the app is only the page that
     * says when and offers to cancel (`PendingDeletionGate`). A server that refuses every other
     * request for it is found out the same way, by the first refusal (lib/error-reporting.tsx).
     * Asked alongside the others, its refusals of them are answered by the handlers above.
     */
    const deletion = await scheduled;
    if (deletion) {
      // Showing the page is the visit's to do, not a hover's. The page is drawn without the frame, so
      // a flag left from an earlier visit would draw the frame first on every load.
      if (!preload) {
        forgetSignedIn();
        showPendingDeletion({ deleteAfter: deletion.deleteAfter });
      }
      return;
    }
    /*
     * Terms to agree to (OpenBot Cloud), before onboarding and everything else: from anywhere to
     * the terms screen, which remembers where they were headed. The terms screen itself is let
     * through here, past the gates after this one, until they agree.
     */
    if (await terms) {
      if (location.pathname === "/terms") return;
      if (!preload) forgetSignedIn();
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
      if (!preload) forgetSignedIn();
      throw redirect({ to: "/onboarding", search: next ? { next } : {} });
    }
    /*
     * Where OpenBot provides no AI (OpenBot Cloud), somebody whose runs have none, neither their own
     * nor their organization's, connects their own before anything else: from anywhere, and
     * somebody who finished onboarding before that step existed too. The onboarding route admits
     * them while it holds. Its question was only asked for somebody who needs no onboarding.
     */
    if (ai && (await ai)) {
      // These pages are drawn without the frame, so a flag left from an earlier visit would draw it, then redirect, on every load.
      if (!preload) forgetSignedIn();
      throw redirect({
        to: "/onboarding",
        search: next ? { step: "ai", next } : { step: "ai" },
      });
    }
    // Before any conversation is drawn, so a long-named action's step never shows its cut name.
    await toolNames;
    /*
     * Only somebody who got past every check into the app is remembered, so the next visit may draw the frame while
     * they run. Onboarding and the terms are let through while the gates still hold, and are drawn without the
     * frame: somebody partway through either would see the frame on their next visit, then be sent back there.
     */
    if (
      !preload &&
      location.pathname !== "/onboarding" &&
      location.pathname !== "/terms"
    )
      rememberSignedIn();
  },
  /*
   * Somebody who was signed in sees the app's frame from the main script's arrival, not a blank page, while the
   * checks above run. It draws nothing for a visitor who never signed in (the skeleton reads the flag itself).
   * While a page that stood in for the app ("Back in a moment", no organization) loads it again, that page is drawn
   * instead, so it never gives way to the empty frame or a blank page (lib/load-again.ts).
   */
  pendingComponent: () => standingInWhileLoadingAgain() ?? <AppFrameSkeleton />,
  pendingMs: 0,
  pendingMinMs: 0,
  /*
   * A browser opened at the address of OpenBot on one computer is refused on the first question,
   * who is signed in: OpenBot answers only its own app there. It is told to open the app instead.
   * Every other failure is the app's error screen, and is told to OpenBot (lib/error-reporting.tsx).
   * The refusal is OpenBot answering as it should, and is not.
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
    // The pending page in place of all of it, from the moment the account is scheduled to be deleted.
    <PendingDeletionGate>
      {/* The held page in place of all of it, the moment the organization holds the person out while it is open. */}
      <HeldOutGate>
        <AuthedApp />
      </HeldOutGate>
    </PendingDeletionGate>
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
          {/* This browser's push subscription, saved again in each organization OpenBot starts in. */}
          <WebPushKeeper />
          {/* The skin saved on the account, drawn over the browser's cached one once it loads. */}
          <SkinAccountSync />
          {/* Opened by the "OpenBot for Business" entry (personal edition and OpenBot Cloud), from whichever skin draws it. */}
          <TeamFeaturesDialog />
          {/*
           * Opened when the free trial is used up, and on every try at something that uses the AI
           * after that, from whichever skin it is tried in (components/plan/card-needed-dialog.tsx).
           */}
          <CardNeededDialog />
          {/* Opened by New organization in the account menu, for somebody who may create one. */}
          <NewOrganizationDialog />
          {/* The command palette, from Cmd/Ctrl+K and from the skins' menus. */}
          <CommandMenu />
          {/* Back from signing in again to delete the account: General settings, where the dialog opens again. */}
          <ResumeAccountDeletion />
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
