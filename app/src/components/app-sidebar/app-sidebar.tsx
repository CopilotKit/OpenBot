import type * as React from "react";
import { useBeforeCommandNavigate } from "@/components/navigation/command-menu";
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useOpenSection } from "@/lib/sections";
import { BotsPanel } from "./bots-panel";
import { ConversationsPanel } from "./conversations-panel";
import { SectionStrip } from "./section-strip";

export {
  hasUnseenActivity,
  isUnread,
  matchingChannels,
  pinnedFirst,
  SEARCH_DEBOUNCE_MS,
  SEARCH_HINT,
  SEARCH_SCOPE,
} from "./conversations-panel";

/**
 * The app's sidebar: the strip of sections, and beside it the open section's panel.
 *
 * Two sidebars inside one, the sidebar library's own way of drawing an icon strip beside a panel.
 * Hiding the panel (⌘B, the edge, a section with no panel) collapses this one down to the strip;
 * the strip never moves. In a narrow window the sheet carries both. The panel is the open section's:
 * Bots' on the Bots section, Conversations' everywhere else.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { setOpenMobile } = useSidebar();
  const { section } = useOpenSection();
  // Opened with Cmd/Ctrl+K over the phone sidebar, the menu closes it before it navigates.
  useBeforeCommandNavigate(() => setOpenMobile(false));
  // One socket for the app, opened here because the sidebar is always there: it keeps the
  // conversation list and every Bot's list in the Bots panel live, whichever panel shows.
  useChannelEvents();

  return (
    <Sidebar
      className="overflow-hidden"
      collapsible="icon"
      variant="inset"
      {...props}
    >
      <div className="flex h-full min-h-0 flex-row">
        <SectionStrip />
        {section === "bots" ? <BotsPanel /> : <ConversationsPanel />}
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
