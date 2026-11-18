import {
  IconLayoutSidebar,
  IconLogout,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Link,
  type LinkOptions,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { BrandName } from "@/components/edition/brand-name";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { SidebarHistoryButtons } from "@/components/layout/sidebar-history";
import {
  openConversationSearch,
  useBeforeCommandNavigate,
  useCommandMenuMode,
} from "@/components/navigation/command-menu";
import { openNewOrganization } from "@/components/organizations/new-organization-dialog";
import { OrganizationMenuItems } from "@/components/organizations/organization-menu";
import { useSwitchOrganization } from "@/components/organizations/use-switch-organization";
import {
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSignOutOffered } from "@/lib/auth/sign-out-offered";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import {
  isNavigationLink,
  type NavigationLink,
  useNavigationItems,
} from "@/lib/navigation";
import {
  useOrganizationChoices,
  useWaitingInvitationCount,
} from "@/lib/organizations/queries";
import { relativeTimeShort } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { useSidebarInverted } from "@/lib/settings/sidebar-layout";
import { BotsNavBadge } from "../bot-profile/attention";
import {
  RecordingDot,
  recordingTooltip,
  useLiveRecording,
} from "../browser/browser-nav-item";
import { navigationRender } from "../edition/team-features-dialog";
import { Button } from "../ui/button";
import {
  AccountMenu,
  accountMenuClassName,
  accountMenuItemClassName as userMenuItemClassName,
} from "./account-label";
import { Channel } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useSignOut } from "./use-sign-out";

// The rail is 48px wide, with a 40px row between these two gutters.
const APP_SIDEBAR_GUTTER = "px-1";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The loaded roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named.
 *
 * Only what is loaded. This sidebar asks the server through the command palette, which searches
 * the whole history; the alternate skins' rosters still narrow their loaded rows with this.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate.
 *
 * Two movements only: a channel that did not exist fades in, and a channel that was just spoken in
 * moves to the top. Nothing else animates, a roster that reacts to being read is a roster that
 * moves under the cursor.
 */
function ChannelRow({
  channel,
  animateOrder,
  emphasis,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  emphasis: MessageListEmphasis;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={{
        opacity: 0,
        transform: shouldReduceMotion ? "none" : "translateY(-8px)",
      }}
      exit={{ opacity: 0 }}
      layout={animateOrder && !shouldReduceMotion ? "position" : false}
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      <Channel
        emphasis={emphasis}
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        summary={channel.summary ?? undefined}
        untitled={untitledLine(channel)}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTimeShort(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        canRename={channel.canRename ?? false}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
  );
}

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

/** A destination row in the sidebar, with optional content at its trailing edge. */
function PrimaryNavItem({
  item,
  tooltip,
  accessibleLabel,
  suppressRestingHover = true,
  children,
}: {
  item: Pick<NavigationLink, "label" | "icon"> & {
    to: NavigationLink["to"] | "/channel/new";
  };
  accessibleLabel?: string;
  suppressRestingHover?: boolean;
  tooltip?: React.ComponentProps<typeof SidebarMenuButton>["tooltip"];
  children?: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // No hover fill under a pointer that has not moved since the page changed (see
        // usePointerRestingSinceNavigation); the open page's row keeps its own.
        className={`h-10 px-1.5! hover:bg-foreground/5 ${suppressRestingHover ? "group-data-[pointer-resting]/footer-menu:hover:bg-transparent group-data-[pointer-resting]/footer-menu:data-[status=active]:hover:bg-foreground/5" : ""}`}
        render={(props) => (
          <Link
            {...props}
            to={item.to}
            activeProps={{ className: "bg-foreground/5" }}
          />
        )}
        tooltip={tooltip ?? item.label}
        aria-label={accessibleLabel}
      >
        <div className="size-7 flex shrink-0 items-center justify-center">
          <item.icon />
        </div>
        <span className="text-sm transition-opacity duration-150 motion-reduce:transition-none group-data-[collapsible=icon]:opacity-0">
          {item.label}
        </span>
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
      tooltip={recording ? recordingTooltip(recording, item.label) : item.label}
    >
      {recording ? <RecordingDot {...recording} /> : null}
    </PrimaryNavItem>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const signOut = useSignOut();
  const signOutOffered = useSignOutOffered();
  // Where OpenBot lists no organizations, the menu has none at all.
  const organizationChoices = useOrganizationChoices();
  const invitationsWaiting = useWaitingInvitationCount();
  const switchOrganization = useSwitchOrganization();
  const pointerResting = usePointerRestingSinceNavigation();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const searchOpen = useCommandMenuMode() === "conversations";
  const visibleChannels = pinnedFirst(channels.data ?? []);
  const animateOrder = (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const navigation = useNavigationItems();
  const { setOpenMobile, isMobile, open, toggleSidebar } = useSidebar();
  const inverted = useSidebarInverted();
  const collapsed = !isMobile && !open;
  // Opened with Cmd/Ctrl+K over the phone sidebar, the menu closes it before it navigates.
  useBeforeCommandNavigate(() => setOpenMobile(false));

  const primaryNavigation = (
    <>
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
    </>
  );
  const layoutNavigation = !inverted || collapsed;

  return (
    <Sidebar variant="inset" collapsible="icon" data-app-sidebar="" {...props}>
      <SidebarHeader
        className={`relative h-14 shrink-0 py-2 after:pointer-events-none after:absolute after:inset-x-1 after:bottom-0 after:border-sidebar-border/75 group-data-[collapsible=icon]:after:border-b ${APP_SIDEBAR_GUTTER}`}
      >
        <SidebarMenu>
          <SidebarMenuItem className="flex h-10 items-center justify-between gap-1">
            <Link
              {...appLinkOptions}
              aria-label={appConfig.brand.productName}
              className="inline-flex h-full w-fit min-w-0 items-center gap-2 ps-1.5 rounded-sm text-lg font-semibold leading-none tracking-[-0.02em] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sidebar-ring"
            >
              {(appConfig.brand.productName === "OpenBot" ||
                appConfig.brand.productName === "OpenBot for Business") && (
                <span className="flex size-7 shrink-0 items-center justify-center">
                  <OpenBotLogo size={24} className="size-6" />
                </span>
              )}
              {collapsed &&
              !["OpenBot", "OpenBot for Business"].includes(
                appConfig.brand.productName,
              ) ? (
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center"
                >
                  {appConfig.brand.productName.charAt(0)}
                </span>
              ) : null}
              <span className="min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none group-data-[collapsible=icon]:opacity-0">
                <BrandName>{appConfig.brand.productName}</BrandName>
              </span>
            </Link>
            {!isMobile && !collapsed ? (
              <div className="flex shrink-0 items-center gap-0.5 pe-1.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Collapse sidebar"
                  className="cursor-pointer hover:bg-foreground/5"
                  title="Collapse sidebar"
                  onClick={toggleSidebar}
                >
                  <IconLayoutSidebar />
                </Button>
                <SidebarHistoryButtons />
              </div>
            ) : null}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent
        ref={scrollRoot}
        className="scroll-fade-b group-data-[collapsible=icon]:overflow-y-auto!"
      >
        <SidebarGroup className={`gap-px ${APP_SIDEBAR_GUTTER}`}>
          <SidebarMenu
            className="group/footer-menu gap-0.5"
            data-pointer-resting={pointerResting || undefined}
          >
            <PrimaryNavItem
              item={{ to: "/channel/new", label: "New", icon: IconPlus }}
              accessibleLabel="New conversation"
              tooltip="New conversation"
              suppressRestingHover={false}
            />
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label="Search conversations"
                aria-haspopup="dialog"
                type="button"
                className="h-10 cursor-pointer px-1.5! hover:bg-foreground/5"
                onClick={openConversationSearch}
                tooltip="Search conversations"
              >
                <span className="flex size-7 shrink-0 items-center justify-center">
                  <IconSearch />
                </span>
                <span className="truncate group-data-[collapsible=icon]:sr-only">
                  Search
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {layoutNavigation ? primaryNavigation : null}
          </SidebarMenu>
          <div className="h-2 w-full" />
          {channels.data?.length === 0 ? (
            <p
              className="px-2 py-2 text-xs leading-5 text-muted-foreground group-data-[collapsible=icon]:hidden"
              data-slot="sidebar-empty-conversations"
            >
              No conversations yet
            </p>
          ) : null}
          <AnimatePresence initial={false}>
            {visibleChannels.map((channel) => (
              <ChannelRow
                emphasis={emphasis}
                key={channel.id}
                animateOrder={animateOrder}
                channel={channel}
              />
            ))}
          </AnimatePresence>
          <ChannelPagination
            query={channels}
            scrollRoot={scrollRoot}
            searching={searchOpen}
          />
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className={APP_SIDEBAR_GUTTER}>
        <SidebarMenu
          className="group/footer-menu gap-px"
          data-pointer-resting={pointerResting || undefined}
        >
          {!layoutNavigation ? primaryNavigation : null}
          <SidebarMenuItem>
            <AccountMenu>
              <DropdownMenuContent
                align="start"
                className={accountMenuClassName}
                side="top"
                sideOffset={8}
              >
                {organizationChoices ? (
                  <OrganizationMenuItems
                    choices={organizationChoices}
                    invitationsWaiting={invitationsWaiting}
                    itemClassName={userMenuItemClassName}
                    onNew={() => {
                      // A narrow window's sheet would wait behind the dialog.
                      setOpenMobile(false);
                      openNewOrganization();
                    }}
                    switching={switchOrganization}
                  />
                ) : null}
                {navigation
                  .filter((item) => item.section === "account")
                  .map((item) => (
                    <DropdownMenuItem
                      className={userMenuItemClassName}
                      key={item.id}
                      nativeButton={item.kind === "dialog"}
                      // A link closes a narrow window's sheet as it is followed; a dialog has to
                      // close it itself, or the sheet waits behind the dialog.
                      render={navigationRender(
                        item,
                        item.kind === "dialog"
                          ? { onClick: () => setOpenMobile(false) }
                          : {},
                      )}
                    >
                      <item.icon />
                      <BrandName>{item.label}</BrandName>
                    </DropdownMenuItem>
                  ))}
                {signOutOffered ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    disabled={signOut.pending}
                    onClick={signOut.run}
                    variant="destructive"
                  >
                    <IconLogout />
                    Sign out
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </AccountMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
