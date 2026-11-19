import type * as React from "react";
import { useBeforeCommandNavigate } from "@/components/navigation/command-menu";
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar";
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
 * the strip never moves. In a narrow window the sheet carries both. Only Conversations has a panel
 * so far, so that is the panel there is.
 */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { setOpenMobile } = useSidebar();
  // Opened with Cmd/Ctrl+K over the phone sidebar, the menu closes it before it navigates.
  useBeforeCommandNavigate(() => setOpenMobile(false));

  return (
    <Sidebar
      className="overflow-hidden"
      collapsible="icon"
      variant="inset"
      {...props}
    >
      <div className="flex h-full min-h-0 flex-row">
        <SectionStrip />
        <ConversationsPanel />
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
