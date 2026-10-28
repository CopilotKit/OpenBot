import { IconLogout, IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions, useParams } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { type RefObject, useRef, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { getHotkey, hotkeyLabel } from "@/lib/hotkeys/hotkeys";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { type NavigationItem, useNavigationItems } from "@/lib/navigation";
import { relativeTime } from "@/lib/relative-time";
import {
  type MessageListEmphasis,
  useMessageListEmphasis,
} from "@/lib/settings/message-list";
import { BotsNavBadge } from "../bot-profile/attention";
import { BrowserNavItem } from "../browser/browser-nav-item";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel, LIT } from "./channel";
import { ChannelPagination } from "./channel-pagination";
import { useSignOut } from "./use-sign-out";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

/** A control in the sidebar lifts to the card's fill and shadow under the pointer, as a row does. */
const LIT_ON_HOVER = "hover:bg-sidebar-accent hover:shadow-(--shadow-card)";

const NEW_CHAT_KEYS = hotkeyLabel(getHotkey("new-chat").combo);

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * Cap layout animation because `layout` measures every animated row on each reorder.
 */
const MAX_ANIMATED_ROWS = 60;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, and the last message, because those are the things the
 * row can actually show — searching against something invisible returns results a person cannot
 * account for. The last message is included because it is still what the second line draws until the
 * conversation has been named. Message history beyond that line is not here to search: it lives in
 * the thread store, and reaching for it is a server endpoint rather than a filter.
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
    [channel.name, channel.summary, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
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
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        unread={unread}
        // A turn running, or work the conversation waits on between turns: a hop, a routine.
        busy={(channel.busy ?? false) || (channel.work?.length ?? 0) > 0}
      />
    </motion.div>
  );
}

/**
 * A count beside a destination, drawn as the Bots count is so the two read as one kind of thing.
 * Nothing for zero.
 */
function NavigationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} ${count === 1 ? "thing needs" : "things need"} you`}
      className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums"
      role="img"
    >
      {count}
    </span>
  );
}

/** One destination in the sidebar's footer, from the shared list, with its count when it has one. */
export function NavigationEntry({ item }: { item: NavigationItem }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className={`h-10 ${LIT_ON_HOVER}`}
        render={(props) => (
          <Link {...props} to={item.to} activeProps={{ className: LIT }} />
        )}
      >
        <div className="size-[28px] flex items-center justify-center">
          <item.icon />
        </div>
        <span className="type-sub">{item.label}</span>
        {/* What waits on you across every Bot; Bots lists them first. */}
        {item.id === "bots" ? <BotsNavBadge /> : null}
        {item.badge ? <NavigationBadge count={item.badge} /> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Puts the cursor in the search box as soon as it is on the page, with what it holds selected so
 * typing replaces the last search. On a narrow window the sidebar is a sheet that only mounts once
 * it opens, and a frame later moves focus to its first control; trying again on each of the next
 * few frames lands after both.
 */
function focusWhenDrawn(box: RefObject<HTMLInputElement | null>, frames = 10) {
  const input = box.current;
  if (input?.isConnected) {
    input.focus();
    input.select();
    if (document.activeElement === input) return;
  }
  if (frames > 0) requestAnimationFrame(() => focusWhenDrawn(box, frames - 1));
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const emphasis = useMessageListEmphasis();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const signOut = useSignOut();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const searchBox = useRef<HTMLInputElement>(null);
  const scrollRoot = useRef<HTMLDivElement>(null);
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  /*
   * ⌘K opens the sidebar, or its sheet on a narrow window, with the cursor in its search box. Bound
   * here, so it works wherever this sidebar is: not on Settings or Admin, which have sidebars of
   * their own, and not under a skin, which draws its own frame.
   */
  useHotkey("search", () => {
    if (isMobile) setOpenMobile(true);
    else setOpen(true);
    focusWhenDrawn(searchBox);
  });
  const searching = search.trim().length > 0;
  const visibleChannels = pinnedFirst(matchingChannels(channels.data, search));
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;
  const navigation = useNavigationItems();

  return (
    <Sidebar {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            <SidebarMenuButton
              className={`type-sub h-full font-semibold ${LIT_ON_HOVER}`}
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {/* OpenBot's own mark, clipped to its circle as every face below it is. */}
                  <span className="block size-5 shrink-0 overflow-hidden rounded-full">
                    <AgentOrb size="20px" />
                  </span>
                  <span>{appConfig.brand.productName}</span>
                </Link>
              )}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="New conversation"
                    // Ghost's own hover is the muted grey, which is the sidebar's: it would not show.
                    className={`${LIT_ON_HOVER} dark:hover:bg-sidebar-accent`}
                    size="icon"
                    variant="ghost"
                    render={(props) => (
                      <Link
                        {...props}
                        to="/channel/new"
                        activeProps={{ className: LIT }}
                      />
                    )}
                  />
                }
              >
                <IconPlus />
              </TooltipTrigger>
              {/* An accelerator nobody is told about is not a feature. */}
              <TooltipContent side="bottom">
                New conversation
                <span className="text-background/60">{NEW_CHAT_KEYS}</span>
              </TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={scrollRoot} className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
              <InputGroup className="bg-sidebar-accent text-sm rounded-lg h-9">
                <InputGroupInput
                  aria-label="Search conversations"
                  ref={searchBox}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            <div className="w-full h-2" />
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>
                      {channels.hasNextPage
                        ? "No loaded conversations match your search"
                        : "No conversations match your search"}
                    </EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      {channels.hasNextPage
                        ? "Load older conversations to search more of your history."
                        : `No conversation has “${search.trim()}” in its name or latest message.`}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>No conversations yet</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Start a conversation with a Bot and it shows up here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
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
              searching={searching}
            />
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          {/* In the list's own order, so a destination goes where `lib/navigation.ts` puts it. */}
          {navigation
            .filter((item) => item.section === "primary")
            .map((item) => (
              <NavigationEntry item={item} key={item.id} />
            ))}
          {/* Your own browser, with the Recorder in it. Drawn only where OpenBot can run one for you. */}
          <BrowserNavItem />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    className={`h-10 aria-expanded:bg-sidebar-accent aria-expanded:shadow-(--shadow-card) ${LIT_ON_HOVER}`}
                  />
                }
              >
                <UserAvatar />
                <span className="type-sub">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {navigation
                  .filter((item) => item.section === "account")
                  .map((item) => (
                    <DropdownMenuItem
                      className={userMenuItemClassName}
                      key={item.id}
                      render={<Link to={item.to} />}
                    >
                      <item.icon />
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.pending}
                  onClick={signOut.run}
                  variant="destructive"
                >
                  <IconLogout />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
