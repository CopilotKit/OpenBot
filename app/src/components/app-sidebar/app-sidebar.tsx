import { IconPlus } from "@tabler/icons-react";
import { Link, type LinkOptions, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { BrandName } from "@/components/edition/brand-name";
import { useBeforeCommandNavigate } from "@/components/navigation/command-menu";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import {
  isNavigationLink,
  type NavigationLink,
  useNavigationItems,
} from "@/lib/navigation";
import { BotsNavBadge } from "../bot-profile/attention";
import {
  RecordingDot,
  recordingTooltip,
  useLiveRecording,
} from "../browser/browser-nav-item";
import { Button } from "../ui/button";
import { AccountMenu, accountMenuClassName } from "./account-label";
import { AccountMenuItems, useAccountMenu } from "./account-menu-items";
import { ConversationRoster } from "./conversation-roster";

export {
  hasUnseenActivity,
  isUnread,
  matchingChannels,
  pinnedFirst,
  SEARCH_DEBOUNCE_MS,
  SEARCH_HINT,
  SEARCH_SCOPE,
} from "./conversation-roster";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

/**
 * Whether the pointer has stayed where it was since the page last changed.
 *
 * The account menu opens upwards, over the rows above it, and Invitations sits right over Bots. Chosen
 * from there, the menu goes and leaves the pointer resting on Bots, which took its hover fill: the
 * same fill the open page's row has, so on /invitations Bots read as the page that was open. Until
 * the pointer moves, a row it happens to be over is not filled. A browser can tell the page what is
 * under a pointer that did not move, with no distance moved; only a real move counts.
 */
function usePointerRestingSinceNavigation(): boolean {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [movedOn, setMovedOn] = useState<string | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const moved = (event: PointerEvent) => {
      // By the distance the event reports, or, where a browser reports none, by where it lands.
      const before = last.current;
      last.current = { x: event.clientX, y: event.clientY };
      if (
        event.movementX !== 0 ||
        event.movementY !== 0 ||
        (before !== null &&
          (before.x !== event.clientX || before.y !== event.clientY))
      )
        setMovedOn(pathname);
    };
    window.addEventListener("pointermove", moved);
    return () => window.removeEventListener("pointermove", moved);
  }, [pathname]);
  return movedOn !== pathname;
}

/** One of the main menu's own destinations, in the sidebar's footer, with what goes at the end of its row. */
function PrimaryNavItem({
  item,
  tooltip,
  children,
}: {
  item: NavigationLink;
  tooltip?: React.ComponentProps<typeof SidebarMenuButton>["tooltip"];
  children?: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // No hover fill under a pointer that has not moved since the page changed (see
        // usePointerRestingSinceNavigation); the open page's row keeps its own.
        className="hover:bg-foreground/5 h-10 group-data-[pointer-resting]/footer-menu:hover:bg-transparent group-data-[pointer-resting]/footer-menu:data-[status=active]:hover:bg-foreground/5"
        render={(props) => (
          <Link
            {...props}
            to={item.to}
            activeProps={{ className: "bg-foreground/5" }}
          />
        )}
        tooltip={tooltip}
      >
        <div className="size-[28px] flex items-center justify-center">
          <item.icon />
        </div>
        <span className="text-sm">{item.label}</span>
        {children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The Skills entry. While any of the person's Recorders records, it carries a red dot named for the recording, and a
 * tooltip saying the same, as the Teach a Bot entry once did. Nothing extra otherwise.
 */
function SkillsNavItem({ item }: { item: NavigationLink }) {
  const recording = useLiveRecording();
  return (
    <PrimaryNavItem
      item={item}
      tooltip={recordingTooltip(recording, item.label)}
    >
      {recording ? <RecordingDot {...recording} /> : null}
    </PrimaryNavItem>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const accountMenu = useAccountMenu();
  const pointerResting = usePointerRestingSinceNavigation();
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const navigation = useNavigationItems();
  const { setOpenMobile } = useSidebar();
  // Opened with Cmd/Ctrl+K over the phone sidebar, the menu closes it before it navigates.
  useBeforeCommandNavigate(() => setOpenMobile(false));

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            {/* The same hover as every other row in the sidebar, not the menu button's accent tint. */}
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight hover:bg-foreground/5 hover:text-sidebar-foreground active:bg-foreground/5 active:text-sidebar-foreground"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <BrandName>{appConfig.brand.productName}</BrandName>
                </Link>
              )}
            />
            {/* Square, as tall as the name beside it, with the sidebar's hover rather than `muted`, which
                is nearly the sidebar's own colour. */}
            <Button
              aria-label="New conversation"
              className="aspect-square h-full w-auto hover:bg-foreground/5 dark:hover:bg-foreground/5"
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <ConversationRoster scrollRoot={scrollRoot} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu
          className="group/footer-menu gap-px"
          data-pointer-resting={pointerResting || undefined}
        >
          {navigation
            .filter(isNavigationLink)
            .filter((item) => item.section === "primary")
            .map((item) =>
              // Skills says when a recording is live: teaching a Bot a task is how a skill is recorded.
              item.id === "skills" ? (
                <SkillsNavItem item={item} key={item.id} />
              ) : (
                <PrimaryNavItem item={item} key={item.id}>
                  {/* What waits on you across every Bot; Bots lists them first. */}
                  {item.id === "bots" ? <BotsNavBadge /> : null}
                </PrimaryNavItem>
              ),
            )}
          <SidebarMenuItem>
            <AccountMenu>
              <DropdownMenuContent
                align="start"
                className={accountMenuClassName}
                side="top"
                sideOffset={8}
              >
                <AccountMenuItems
                  menu={accountMenu}
                  onNavigate={() => setOpenMobile(false)}
                />
              </DropdownMenuContent>
            </AccountMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
