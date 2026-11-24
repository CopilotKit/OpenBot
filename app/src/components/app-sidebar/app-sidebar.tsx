import type * as React from "react";
import { useState } from "react";
import { useBeforeCommandNavigate } from "@/components/navigation/command-menu";
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { useOpenSection } from "@/lib/sections";
import { useKit } from "@/skins/store";
import { BotsPanel } from "./bots-panel";
import { ConversationsPanel } from "./conversations-panel";
import { SectionStrip } from "./section-strip";
import { SidebarTitleBar } from "./sidebar-title-bar";

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
 *
 * In OpenBot's own look a title bar runs across the top of both (`SidebarTitleBar`): the window's
 * buttons, and OpenBot's mark and name. Not in a narrow window's sheet, which has no window to draw.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { setOpenMobile, isMobile } = useSidebar();
  const titled = useKit() === "current" && !isMobile;
  const { section } = useOpenSection();
  /*
   * Both panels stay mounted once shown, the one not open out of sight: going back to a panel finds
   * it as it was left (its search, its scroll, which Bots are open), and the Bots panel's top three
   * are taken once a page, not again on every visit. The Bots panel waits to be first opened.
   */
  const bots = section === "bots";
  const [botsShown, setBotsShown] = useState(bots);
  if (bots && !botsShown) setBotsShown(true);
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
      {titled ? <SidebarTitleBar /> : null}
      {/* In OpenBot Desktop on macOS, what shows of this row past the strip moves the window too. */}
      <div className="flex min-h-0 flex-1 flex-row" data-desktop-drag="">
        <SectionStrip />
        <ConversationsPanel hidden={bots} />
        {botsShown ? <BotsPanel hidden={!bots} /> : null}
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
