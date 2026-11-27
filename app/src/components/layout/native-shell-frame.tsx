import type { ReactNode } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { PlanBanner } from "@/components/layout/plan-banner";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { UpdateBanner } from "@/components/layout/update-banner";
import { MovedAppsBanner } from "@/components/moves/moved-apps-notice";
import { MovedElsewhereBanner } from "@/components/moves/moved-elsewhere-banner";
import { LeftOrganizationBanner } from "@/components/organizations/left-organization-banner";
import { SidebarInset } from "@/components/ui/sidebar";
import { useChannelEvents } from "@/lib/channels/use-channel-events";

/**
 * The page and nothing around it, for the phone app's native shell (`lib/native-shell`), which
 * draws the status bar and the tab bar outside the web view. Exactly the web view's height, never
 * scrolls itself: panes scroll inside, as in every other shell. No sidebar provider, so no sidebar,
 * no drawer and no "Show sidebar" anywhere (`useSidebarToggleVisible`), and no safe-area padding:
 * the shell lays the web view out between its bars.
 *
 * The same panel as the app's (`SidebarInset`, which needs no sidebar), so a screen that sizes
 * itself against it (`route-error.tsx`) does here too.
 */
export function NativeShellPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-svh w-full flex-col overflow-hidden">
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        {children}
      </SidebarInset>
    </div>
  );
}

/**
 * The app's frame in the native shell: the banners the sidebar frame shows, and what the sidebar
 * did beyond drawing (`app-sidebar.tsx`): the app's one socket, which keeps the conversation list
 * live, and the Bots badge, which sends the browser notification when a Bot starts needing the
 * person, mounted unseen as OpenDuet's frame does.
 */
export function NativeShellFrame({ children }: { children: ReactNode }) {
  useChannelEvents();
  return (
    <NativeShellPanel>
      <div hidden>
        <BotsNavBadge />
      </div>
      <ConnectionBanner />
      <LeftOrganizationBanner />
      <PlanBanner />
      <MovedElsewhereBanner />
      <MovedAppsBanner />
      <UpdateBanner />
      <SelfHostBanner />
      {children}
    </NativeShellPanel>
  );
}
