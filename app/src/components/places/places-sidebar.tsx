import { useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect } from "react";
import { useAccountMenu } from "@/components/app-sidebar/account-menu-items";
import { useBeforeCommandNavigate } from "@/components/navigation/command-menu";
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { placeForPath } from "@/lib/places/places";
import { getPlace, setPlace } from "@/lib/places/store";
import { PlacePanel } from "./place-panel";
import { Strip } from "./strip";

/**
 * The sidebar with places: the strip down its left edge and the chosen place's list beside it. A
 * drop-in for `AppSidebar`. Opening a page that belongs to a place chooses that place; any other
 * page, a conversation among them, leaves the place where it was.
 */
export function PlacesSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const accountMenu = useAccountMenu();
  // One socket for the app, opened where the lists are kept live.
  useChannelEvents();
  const { setOpenMobile } = useSidebar();
  // Opened with Cmd/Ctrl+K over the phone sidebar, the menu closes it before it navigates.
  useBeforeCommandNavigate(() => setOpenMobile(false));
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  useEffect(() => {
    const next = placeForPath(pathname);
    if (next && next !== getPlace()) setPlace(next);
  }, [pathname]);

  return (
    <Sidebar variant="inset" {...props}>
      <div className="flex min-h-0 flex-1 flex-row">
        <Strip accountMenu={accountMenu} />
        <div className="flex min-w-0 flex-1 flex-col">
          <PlacePanel />
        </div>
      </div>
      <SidebarRail />
    </Sidebar>
  );
}
