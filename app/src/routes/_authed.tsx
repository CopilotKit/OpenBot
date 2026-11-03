import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BotLookProvider } from "../components/agents/bot-look";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";
import { SkinAccountSync } from "../skins/account-sync";
import { useActiveSkin } from "../skins/registry";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) {
      throw redirect({ to: "/sign" });
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
      {/* The skin saved on the account, drawn over the browser's cached one once it loads. */}
      <SkinAccountSync />
      {/* Opened by the personal edition's "OpenBot for Business" entry, from whichever skin draws it. */}
      <TeamFeaturesDialog />
      <SkinBotLook>
        <Outlet />
      </SkinBotLook>
    </CopilotProvider>
  ),
});

/** Bots are drawn the way the active skin asks for, on every authed page. */
function SkinBotLook({ children }: { children: ReactNode }) {
  return (
    <BotLookProvider value={useActiveSkin().botLook ?? "face"}>
      {children}
    </BotLookProvider>
  );
}
