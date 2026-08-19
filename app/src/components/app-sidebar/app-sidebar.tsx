import {
  IconBolt,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconBox,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { useState } from "react";
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
} from "@/components/ui/sidebar";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { useWaitingBots } from "@/lib/notifications/waiting";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

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

const ENTRANCE_SECONDS = 0.2;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name and the last thing said in it, because those are the two things the
 * row actually shows — searching against something invisible returns results a person cannot
 * account for. Message history beyond the last line is not here to search: it lives in the thread
 * store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
function matchingChannels(
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
    [channel.name, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
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
  waiting,
}: {
  channel: ChannelSummary;
  animateOrder: boolean;
  waiting: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
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
        channelId={channel.id}
        participantIds={channel.agentIds}
        name={channel.name}
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        waiting={waiting}
      />
    </motion.div>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const channels = useQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live. It also carries the notifications
  // that set the markers below.
  useChannelEvents();
  const waitingBots = useWaitingBots();
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const visibleChannels = matchingChannels(channels.data, search);
  /*
   * FILTERING DOES NOT ANIMATE. Rows exit and relayout on every keystroke otherwise, which is a
   * list thrashing under somebody who is still typing — and the moving target is the very thing
   * they are trying to read. Order animation is for a channel that was just spoken in, which is
   * occasional; this is not.
   */
  const animateOrder =
    !searching && (channels.data?.length ?? 0) <= MAX_ANIMATED_ROWS;

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    await navigate({ to: "/sign" });
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row gap-1.5">
            <SidebarMenuButton
              className="font-semibold text-[14px] tracking-tighter h-full leading-tight"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            <Button
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
      <SidebarContent className="scroll-fade-b">
        <SidebarMenu>
          <SidebarGroup className="gap-px">
            <SidebarMenuItem>
              <InputGroup className="bg-background text-sm rounded-lg h-9">
                <InputGroupInput
                  aria-label="Search channels"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search..."
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
                    <EmptyTitle>No channels match your search</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Nothing here is named “{search.trim()}”, and nobody has
                      said it recently either.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
              <div className="py-4">
                <Empty className="border border-dashed min-h-[40dvh]">
                  <EmptyHeader>
                    <EmptyTitle>You don't have channels yet</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Start talking to agents and your channels will appear
                      here.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            <AnimatePresence initial={false}>
              {visibleChannels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  animateOrder={animateOrder}
                  channel={channel}
                  // Written for however many coworkers a channel holds rather than for the one it
                  // holds: the marker belongs to the row somebody would click, and any Bot behind it
                  // waiting is reason enough to mark it.
                  waiting={channel.agentIds.some(
                    (agentId) => waitingBots[agentId] !== undefined,
                  )}
                />
              ))}
            </AnimatePresence>
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            {/* Beside Agents rather than inside Admin: writing a skill is something anybody does. */}
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/skills"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconBox />
              </div>
              <span className="text-sm trackint-tight">Skills</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/agents"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconBolt />
              </div>
              <span className="text-sm trackint-tight">Agents</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="text-sm trackint-tight">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
                {currentUser?.role === "admin" ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    render={<Link {...adminLinkOptions} />}
                  >
                    <IconShieldLock />
                    Admin
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  render={<Link {...settingsLinkOptions} />}
                >
                  <IconSettings />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.isPending}
                  onClick={handleSignOut}
                  variant="destructive"
                >
                  <IconLogout />
                  Log out
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

const RELATIVE_UNITS = [
  { limit: 60_000, divisor: 1_000, unit: "second" },
  { limit: 3_600_000, divisor: 60_000, unit: "minute" },
  { limit: 86_400_000, divisor: 3_600_000, unit: "hour" },
  { limit: 604_800_000, divisor: 86_400_000, unit: "day" },
  { limit: Number.POSITIVE_INFINITY, divisor: 604_800_000, unit: "week" },
] as const;

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/** Locale-aware relative timestamp, e.g. "2 minutes ago". */
function relativeTime(iso: string) {
  const elapsed = Date.now() - new Date(iso).getTime();
  const scale =
    RELATIVE_UNITS.find(({ limit }) => Math.abs(elapsed) < limit) ??
    RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  return relativeFormat.format(
    -Math.round(elapsed / scale.divisor),
    scale.unit,
  );
}
