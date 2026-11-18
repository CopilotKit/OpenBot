import { IconPinFilled, IconPlus, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { BotKite } from "@/components/agents/kite/bot-kite";
import { KiteMark } from "@/components/agents/kite/kite-mark";
import { AppSidebarFooter } from "@/components/app-sidebar/app-sidebar";
import { ConversationMenu } from "@/components/app-sidebar/channel";
import { ChannelAvatar } from "@/components/channels/avatar";
import { BrandName } from "@/components/edition/brand-name";
import {
  openCommandMenu,
  useBeforeCommandNavigate,
} from "@/components/navigation/command-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { conversationTitle } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTimeShort } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import {
  activityOf,
  groupConversations,
  type KiteBot,
  kiteBots,
  needingYou,
  openBotId,
  unseen,
} from "./roster";

/** How many of a Bot's conversations show under it before "Show all". */
const SHOWN_CONVERSATIONS = 5;

const SHORTCUT = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  ? "⌘K"
  : "Ctrl K";

/** Every row's shape: 32px, the sidebar's hover, and the open page's fill. */
const row =
  "group/row relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-sidebar-foreground/80 outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";
const openRow = "bg-sidebar-accent font-medium text-sidebar-foreground";

/**
 * A Bot's kite in a row: 22px, the smallest a kite has a face at, so a Bot can look up when you point
 * at it. Whatever leads any other row sits in a slot of the same width, so every name lines up.
 */
const KITE_SIZE = 22;
const slot = "grid size-[22px] shrink-0 place-items-center";

/**
 * The conversation open on screen, from the path: OpenBot serves a conversation with one Bot at
 * `/channel/:id` and one with several at `/group/:id`.
 */
function openConversationId(pathname: string): string | undefined {
  return /^\/(?:channel|group)\/([^/]+)/.exec(pathname)?.[1];
}

/** Where a conversation opens, by how many Bots are in it. */
function conversationLink(channel: ChannelSummary) {
  return channel.agentIds.length > 1
    ? ({ to: "/group/$channelId", params: { channelId: channel.id } } as const)
    : ({
        to: "/channel/$channelId",
        params: { channelId: channel.id },
      } as const);
}

function titleOf(channel: ChannelSummary): string {
  return conversationTitle(channel) || "New conversation";
}

/**
 * Kite Bot's sidebar. Bots first: every Bot is a row with its kite, and the Bot you are with opens
 * out to show its conversations, so the sidebar says where you are without a second bar on top of
 * OpenBot's pages. Above the Bots, what waits on you and what you pinned; below them, the
 * conversations with more than one Bot. The foot is OpenBot's own: its destinations, the Bots badge
 * and the account menu.
 *
 * It keeps the one thing OpenBot's sidebar does beyond drawing: the socket that keeps every
 * conversation, and so every kite's working pixel, live.
 */
export function KiteSidebar() {
  useChannelEvents();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const openChannel = openConversationId(pathname);
  const loaded = channels.data ?? [];
  const roster = useMemo(
    () => kiteBots(bots.data ?? [], loaded, attention.data ?? [], openChannel),
    [bots.data, loaded, attention.data, openChannel],
  );
  const needs = needingYou(roster);
  const pinned = loaded.filter((channel) => channel.pinned);
  const groups = groupConversations(loaded).filter(
    (channel) => !channel.pinned,
  );
  const openBot = openBotId(pathname, loaded);
  const { isMobile, setOpenMobile } = useSidebar();
  useBeforeCommandNavigate(() => setOpenMobile(false));
  // On a phone the sidebar is a sheet over the page: going anywhere puts it away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on each new path, by design.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname]);

  return (
    <Sidebar data-kitebot-sidebar="" variant="inset">
      <SidebarHeader className="gap-1.5 p-2 pb-1">
        <div className="flex h-9 items-center gap-1">
          <Link
            aria-label={`${appConfig.brand.productName} home`}
            className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 font-semibold text-[14px] tracking-tight outline-none transition-colors duration-150 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            to="/"
          >
            <span className={slot}>
              <KiteMark className="text-sidebar-foreground" size={18} />
            </span>
            <span className="truncate">
              <BrandName>{appConfig.brand.productName}</BrandName>
            </span>
          </Link>
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  aria-label="New conversation"
                  className="grid size-9 shrink-0 place-items-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-[18px]"
                  to="/channel/new"
                />
              }
            >
              <IconPlus />
            </TooltipTrigger>
            <TooltipContent side="bottom">New conversation</TooltipContent>
          </Tooltip>
        </div>
        <button
          className="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 text-[13px] text-muted-foreground shadow-[0_1px_0_0_rgb(0_0_0/0.02)] outline-none transition-colors duration-150 hover:border-foreground/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-4"
          onClick={openCommandMenu}
          type="button"
        >
          <IconSearch />
          <span className="flex-1 text-left">Search</span>
          <kbd className="font-sans text-[11px] text-muted-foreground/80 tracking-wide">
            {SHORTCUT}
          </kbd>
        </button>
      </SidebarHeader>
      <SidebarContent className="scroll-fade-b gap-0 px-2 pb-3">
        {needs.length > 0 ? (
          <Section label="Needs you">
            {needs.map((one) => (
              <NeedsYouRow
                channels={loaded}
                key={one.bot.id}
                one={one}
                pathname={pathname}
              />
            ))}
          </Section>
        ) : null}
        {pinned.length > 0 ? (
          <Section label="Pinned">
            {pinned.map((channel) => (
              <ConversationRow
                channel={channel}
                key={channel.id}
                open={channel.id === openChannel}
              />
            ))}
          </Section>
        ) : null}
        <Section
          action={
            <Link
              className="rounded px-1 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              to="/bots"
            >
              All
            </Link>
          }
          label="Bots"
        >
          {bots.isPending ? (
            Array.from({ length: 4 }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to key on.
              <SidebarMenuSkeleton key={index} showIcon />
            ))
          ) : bots.isError && !bots.data ? (
            <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
              Couldn't load your Bots.
            </p>
          ) : roster.length === 0 ? (
            <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
              No Bots yet.
            </p>
          ) : (
            roster.map((one) => (
              <BotRow
                key={one.bot.id}
                one={one}
                open={one.bot.id === openBot}
                openChannel={openChannel}
                pathname={pathname}
              />
            ))
          )}
        </Section>
        {groups.length > 0 ? (
          <Section label="Groups">
            {groups.map((channel) => (
              <ConversationRow
                channel={channel}
                key={channel.id}
                open={channel.id === openChannel}
              />
            ))}
          </Section>
        ) : null}
      </SidebarContent>
      <AppSidebarFooter compact />
      <SidebarRail />
    </Sidebar>
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="pt-4 first:pt-2">
      <div className="flex h-6 items-center justify-between px-2.5">
        <h2 className="font-medium text-[12px] text-muted-foreground">
          {label}
        </h2>
        {action}
      </div>
      <ul className="mt-0.5 flex flex-col gap-px">{children}</ul>
    </section>
  );
}

/**
 * A Bot that waits on you, and the way to what it waits on: the conversation it asked in, or its
 * page, where questions and approvals are answered.
 */
function NeedsYouRow({
  one,
  channels,
  pathname,
}: {
  one: KiteBot;
  channels: readonly ChannelSummary[];
  pathname: string;
}) {
  const where = one.waitingIn
    ? channels.find((channel) => channel.id === one.waitingIn)
    : undefined;
  const link = where
    ? conversationLink(where)
    : ({ to: "/bots/$agentId", params: { agentId: one.bot.id } } as const);
  const here = where
    ? pathname.endsWith(`/${where.id}`)
    : pathname.startsWith(`/bots/${one.bot.id}`);
  return (
    <li>
      <Link {...link} className={cn(row, here && openRow)}>
        <BotKite
          name={one.bot.name}
          seed={one.bot.avatarSeed}
          size={KITE_SIZE}
          state="waiting"
        />
        <span className="min-w-0 flex-1 truncate">{one.bot.name}</span>
        <span
          className="min-w-5 rounded-full bg-amber-500/15 px-1.5 text-center font-medium text-[11px] text-amber-700 tabular-nums leading-5 dark:text-amber-300"
          title={`${one.waiting} waiting on you`}
        >
          {one.waiting}
        </span>
      </Link>
    </li>
  );
}

/**
 * One Bot: its kite, its name, and what is new with it. Choosing it opens its newest conversation,
 * or starts one when there is none. While it is the Bot you are with, its conversations open out
 * under it and its kite stays awake; any other Bot's kite wakes while you point at its row or tab
 * to it.
 */
function BotRow({
  one,
  open,
  openChannel,
  pathname,
}: {
  one: KiteBot;
  open: boolean;
  openChannel: string | undefined;
  pathname: string;
}) {
  const reduce = useReducedMotion();
  const [all, setAll] = useState(false);
  const [contact, setContact] = useState(false);
  const latest = one.conversations[0];
  const link = latest
    ? conversationLink(latest)
    : ({ to: "/channel/new", search: { agent: one.bot.id } } as const);
  const onBotPage = pathname.startsWith(`/bots/${one.bot.id}`);
  const shown = all
    ? one.conversations
    : one.conversations.slice(0, SHOWN_CONVERSATIONS);
  const hidden = one.conversations.length - shown.length;

  return (
    <li>
      <div className="group/bot relative">
        <Link
          {...link}
          className={cn(
            row,
            "pr-8",
            onBotPage && openRow,
            open && !onBotPage && "font-medium text-sidebar-foreground",
          )}
          onBlur={() => setContact(false)}
          onFocus={() => setContact(true)}
          onPointerEnter={() => setContact(true)}
          onPointerLeave={() => setContact(false)}
        >
          <span
            className={cn(
              "transition-opacity duration-200",
              one.paused && "opacity-45",
            )}
          >
            <BotKite
              awake={(open || contact) && !one.paused}
              look={[0, 0]}
              name={one.bot.name}
              seed={one.bot.avatarSeed}
              size={KITE_SIZE}
              state={one.paused ? "idle" : one.state}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{one.bot.name}</span>
          {one.paused ? (
            <span className="text-[11px] text-muted-foreground">Paused</span>
          ) : one.unread ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-foreground"
              title="New messages"
            />
          ) : null}
        </Link>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                aria-label={`New conversation with ${one.bot.name}`}
                className={cn(
                  "absolute top-1 right-1 grid size-6 place-items-center rounded text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] duration-150 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/bot:opacity-100 [&_svg]:size-3.5",
                  // A phone has no hover: only the open Bot offers it there.
                  open ? "max-md:opacity-100" : "max-md:hidden",
                )}
                search={{ agent: one.bot.id }}
                to="/channel/new"
              />
            }
          >
            <IconPlus />
          </TooltipTrigger>
          <TooltipContent side="right">
            New conversation with {one.bot.name}
          </TooltipContent>
        </Tooltip>
      </div>
      <AnimatePresence initial={false}>
        {open && one.conversations.length > 0 ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="ml-5 overflow-hidden border-sidebar-border border-l pl-[11px]"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduce ? 0 : ENTRANCE_SECONDS,
              ease: EASE_OUT,
            }}
          >
            <ul className="flex flex-col gap-px py-0.5">
              {shown.map((channel) => (
                <ConversationRow
                  channel={channel}
                  key={channel.id}
                  nested
                  open={channel.id === openChannel}
                />
              ))}
              {hidden > 0 ? (
                <li>
                  <button
                    className={cn(row, "h-7 text-[12px] text-muted-foreground")}
                    onClick={() => setAll(true)}
                    type="button"
                  >
                    Show {hidden} more
                  </button>
                </li>
              ) : null}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

/**
 * A conversation: under its Bot, just what it is about and when it last moved; on its own (pinned,
 * or with several Bots), led by its Bots' kites. Right-click offers what OpenBot's roster does.
 */
function ConversationRow({
  channel,
  open,
  nested = false,
}: {
  channel: ChannelSummary;
  open: boolean;
  nested?: boolean;
}) {
  const title = titleOf(channel);
  const unread = !open && unseen(channel);
  return (
    <li>
      <ConversationMenu
        canRename={channel.canRename ?? false}
        channelId={channel.id}
        open={open}
        pinned={channel.pinned}
        title={conversationTitle(channel)}
      >
        <Link
          {...conversationLink(channel)}
          className={cn(row, nested && "h-7 gap-2", open && openRow)}
          title={title}
        >
          {nested ? null : channel.agentIds.length > 1 ? (
            <KitePair ids={channel.agentIds} working={channel.busy === true} />
          ) : (
            <span className={slot}>
              <ChannelAvatar
                participantIds={channel.agentIds}
                size={18}
                typing={channel.busy === true}
              />
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              unread && "font-medium text-sidebar-foreground",
            )}
          >
            {title}
          </span>
          {channel.busy ? (
            <span className="shrink-0 font-medium text-[11px] text-[#2f6fed] dark:text-[#6c9cff]">
              Working
            </span>
          ) : unread ? (
            <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
          ) : nested && channel.pinned ? (
            <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums opacity-0 transition-opacity duration-150 group-hover/row:opacity-100">
              {relativeTimeShort(activityOf(channel))}
            </span>
          )}
        </Link>
      </ConversationMenu>
    </li>
  );
}

/**
 * A conversation with several Bots, as two of their kites flying together in the space of one: the
 * second a little lower and to the right, over the first. Two kites of a row's size side by side
 * would push its words out of line with every other row's.
 */
function KitePair({ ids, working }: { ids: string[]; working: boolean }) {
  const bots = useQuery(agentListQueryOptions()).data;
  const kites = ids.slice(0, 2).map((id) => {
    const bot = bots?.find((one) => one.id === id);
    return { id, name: bot?.name ?? "", seed: bot?.avatarSeed ?? id };
  });
  return (
    <span className="relative size-[22px] shrink-0">
      {kites.map((kite, index) => (
        <span
          className={cn(
            "absolute",
            index === 0 ? "top-0 left-0" : "right-0 bottom-0",
          )}
          key={kite.id}
        >
          <BotKite
            name={kite.name}
            seed={kite.seed}
            size={15}
            state={working ? "working" : "idle"}
          />
        </span>
      ))}
    </span>
  );
}
