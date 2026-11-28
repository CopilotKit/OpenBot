import {
  IconChevronDown,
  IconMessagePlus,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { attentionSummary } from "@/components/bot-profile/attention";
import { SectionPanel } from "@/components/layout/section-panel";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { SidebarContent } from "@/components/ui/sidebar";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import {
  BOT_CONVERSATIONS_PAGE,
  orderBots,
  useExpandedBots,
} from "@/lib/bots/panel";
import { untitledLine } from "@/lib/channels/label";
import {
  botConversationsInfiniteQueryOptions,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { isHeld, loadFailure } from "@/lib/load-failure";
import { relativeTimeShort } from "@/lib/relative-time";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import { delegatingConversationsQueryOptions } from "@/lib/tasks/queries";
import { cn } from "@/lib/utils";
import { Channel } from "./channel";
import {
  isUnread,
  isWorking,
  NONE_DELEGATING,
  pinnedFirst,
} from "./conversations-panel";

/** Where a Bot's row hands up that its conversations are held back, by Bot, for the panel to say once. */
const HeldReads = createContext<(botId: string, held: unknown) => void>(
  () => {},
);

/** The row under a Bot that is not a conversation: Show more, and New conversation. */
const BOT_LIST_ACTION_ROW =
  "w-full justify-start px-2.5 font-normal text-muted-foreground text-sm";

/**
 * One Bot's latest conversations, under its row: {@link BOT_CONVERSATIONS_PAGE} at a time, read from
 * the server by Bot, drawn as the compact conversation row. Show more reads the next page in place.
 * A read that failed says so with Retry, never as no conversations. A conversation with the Bot
 * starts here too, as its page's Message does: "Start one" when it has none, and a New conversation
 * row first when it has some.
 */
function BotConversations({
  botId,
  botName,
}: {
  botId: string;
  botName: string;
}) {
  const emphasis = useMessageListEmphasis();
  const conversations = useInfiniteQuery(
    botConversationsInfiniteQueryOptions(botId, BOT_CONVERSATIONS_PAGE),
  );
  const delegating =
    useQuery(delegatingConversationsQueryOptions()).data ?? NONE_DELEGATING;
  const openChannelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  /*
   * OpenBot holding off (a move, a brief outage) is the same for every Bot: the panel says it once
   * above its Bots (`HeldReads`), and the row says nothing of its own. It said it under every Bot.
   */
  const reportHeld = useContext(HeldReads);
  const held =
    !conversations.data && isHeld(conversations.error)
      ? conversations.error
      : undefined;
  useEffect(() => {
    reportHeld(botId, held);
    return () => reportHeld(botId, undefined);
  }, [reportHeld, botId, held]);

  if (held) return null;
  if (conversations.isPending)
    return (
      <p role="status" className="py-1.5 pl-3 text-muted-foreground text-xs">
        Loading…
      </p>
    );
  if (!conversations.data)
    return (
      <div className="flex items-center gap-2 py-1 pl-3">
        <p
          role="alert"
          className="min-w-0 flex-1 text-muted-foreground text-xs"
        >
          {loadFailure(
            conversations.error,
            conversations.error?.message ||
              "Couldn't load this Bot's conversations.",
          )}
        </p>
        <Button
          disabled={conversations.isFetching}
          onClick={() => void conversations.refetch()}
          size="sm"
          variant="ghost"
        >
          Retry
        </Button>
      </div>
    );
  if (conversations.data.length === 0)
    return (
      // The app's inline link, as in an item's description or an empty state.
      <p className="py-1.5 pl-3 text-muted-foreground text-xs [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4">
        No conversations with this Bot yet.{" "}
        <Link
          aria-label={`Start one with ${botName}`}
          // Whole on one line: a link split across two reads as two.
          className="whitespace-nowrap"
          search={{ agent: botId }}
          to="/channel/new"
        >
          Start one
        </Link>
        .
      </p>
    );
  return (
    <>
      {/* A link drawn as Show more is, so it opens in a new tab like the rows under it. */}
      <Link
        aria-label={`New conversation with ${botName}`}
        className={cn(
          buttonVariants({ size: "sm", variant: "ghost" }),
          BOT_LIST_ACTION_ROW,
        )}
        search={{ agent: botId }}
        to="/channel/new"
      >
        New conversation
      </Link>
      {/* Pinned first, as the Conversations panel draws them: a live patch reorders by time alone. */}
      {pinnedFirst(conversations.data).map((channel) => (
        <Channel
          busy={isWorking(channel, delegating)}
          canRename={channel.canRename ?? false}
          channelId={channel.id}
          data-slot="bot-conversation-row"
          emphasis={emphasis}
          key={channel.id}
          lastMessageAt={
            channel.lastMessageAt
              ? relativeTimeShort(channel.lastMessageAt)
              : undefined
          }
          name={channel.name}
          participantIds={channel.agentIds}
          pinned={channel.pinned}
          summary={channel.summary ?? undefined}
          unread={isUnread(channel, openChannelId)}
          untitled={untitledLine(channel)}
          view="compact"
          avatar={false}
        />
      ))}
      {conversations.hasNextPage ? (
        <Button
          className={BOT_LIST_ACTION_ROW}
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
          size="sm"
          variant="ghost"
        >
          {conversations.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </>
  );
}

/**
 * One Bot: its orb and name, a link to its page, and at the end a dot when something waits on the
 * person from it and the caret that opens and closes its conversations under it. Right-clicking the
 * Bot offers a new conversation with it, as a conversation's row offers its own actions.
 */
function BotRow({
  bot,
  waiting,
  expanded,
  onToggle,
}: {
  bot: AgentProfile;
  /** What waits on the person from this Bot, in words; empty when nothing does. */
  waiting: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  return (
    <li className="flex flex-col">
      {/*
       * Two buttons side by side, each with its own hover, as in Guido's sketch: the Bot, which opens
       * its page, and a square caret, transparent until hovered, which opens its conversations.
       */}
      <div className="flex items-center gap-1" data-slot="bot-row">
        <ContextMenu>
          <ContextMenuTrigger className="min-w-0 flex-1">
            <Link
              className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg pr-2.5 pl-2.5 text-sm outline-hidden ring-sidebar-ring transition-colors hover:bg-foreground/5 focus-visible:ring-2"
              params={{ agentId: bot.id }}
              to="/bots/$agentId"
            >
              <BotOrb name={bot.name} seed={bot.avatarSeed} size={24} />
              <span className="min-w-0 flex-1 truncate">{bot.name}</span>
              {waiting ? (
                <span
                  aria-label={waiting}
                  className="size-2 shrink-0 rounded-full bg-primary"
                  role="img"
                />
              ) : null}
            </Link>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() =>
                void navigate({ search: { agent: bot.id }, to: "/channel/new" })
              }
            >
              <IconMessagePlus />
              New conversation with {bot.name}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${bot.name}'s conversations`}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-transparent text-muted-foreground outline-hidden ring-sidebar-ring transition-colors hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2"
          onClick={onToggle}
          type="button"
        >
          <IconChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </button>
      </div>
      {expanded ? (
        <div className="ml-[21px] border-sidebar-border border-l pl-1.5">
          <BotConversations botId={bot.id} botName={bot.name} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The Bots section's panel: every Bot, newest conversation first (`orderBots`), the top three open
 * with their latest conversations. The search narrows the Bots by name; New Bot is in the header.
 */
export function BotsPanel({ hidden = false }: { hidden?: boolean }) {
  const bots = useQuery(agentListQueryOptions());
  const roster = useInfiniteQuery(channelListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const [search, setSearch] = useState("");

  const ordered = useMemo(
    () => orderBots(bots.data ?? [], roster.data ?? []),
    [bots.data, roster.data],
  );
  const { isExpanded, toggle } = useExpandedBots(
    useMemo(() => ordered.map((bot) => bot.id), [ordered]),
  );
  const term = search.trim().toLowerCase();
  const shown = term
    ? ordered.filter((bot) => bot.name.toLowerCase().includes(term))
    : ordered;
  const waitingOf = (botId: string) => {
    const one = attention.data?.find((each) => each.botId === botId);
    return one ? attentionSummary(one) : "";
  };
  // Each Bot whose conversations OpenBot is holding back, said once above the list.
  const queryClient = useQueryClient();
  const [heldReads, setHeldReads] = useState<ReadonlyMap<string, unknown>>(
    () => new Map(),
  );
  const reportHeld = useCallback((botId: string, held: unknown) => {
    setHeldReads((now) => {
      if (held === undefined ? !now.has(botId) : now.get(botId) === held)
        return now;
      const next = new Map(now);
      if (held === undefined) next.delete(botId);
      else next.set(botId, held);
      return next;
    });
  }, []);
  const held = heldReads.values().next().value;

  return (
    <SectionPanel
      actions={
        <Button
          aria-label="New Bot"
          className="hover:bg-foreground/5"
          render={(props) => (
            <Link {...props} search={{ new: true }} to="/bots" />
          )}
          size="icon"
          variant="ghost"
        >
          <IconPlus />
        </Button>
      }
      className="group-data-[collapsible=icon]:hidden"
      hidden={hidden}
      title="Bots"
    >
      <SidebarContent className="scroll-fade-b px-2 pb-2">
        <InputGroup className="h-9 rounded-lg bg-background text-sm">
          <InputGroupInput
            aria-label="Search Bots"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Bots…"
            value={search}
          />
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
        <div className="h-2 shrink-0" />
        {bots.isPending ? (
          <p
            role="status"
            className="px-2.5 py-1.5 text-muted-foreground text-xs"
          >
            Loading…
          </p>
        ) : !bots.data ? (
          <div className="px-2.5 py-2">
            <p role="alert" className="mb-1 text-muted-foreground text-xs">
              {loadFailure(
                bots.error,
                bots.error?.message || "Couldn't load your Bots.",
              )}
            </p>
            <Button
              disabled={bots.isFetching}
              onClick={() => void bots.refetch()}
              size="sm"
              variant="ghost"
            >
              Retry
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-2.5 py-2 text-muted-foreground text-xs">
            {term
              ? `No Bots match “${search.trim()}”.`
              : "No Bots yet. Make one with New Bot."}
          </p>
        ) : (
          <HeldReads.Provider value={reportHeld}>
            {held !== undefined ? (
              <div className="flex items-center gap-2 px-2.5 pb-1">
                <p
                  role="alert"
                  className="min-w-0 flex-1 text-muted-foreground text-xs"
                >
                  {loadFailure(held, "Couldn't load these conversations.")}
                </p>
                <Button
                  onClick={() =>
                    void queryClient.refetchQueries({
                      queryKey: channelKeys.byBots(),
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  Retry
                </Button>
              </div>
            ) : null}
            <ul className="flex flex-col gap-px">
              {shown.map((bot) => (
                <BotRow
                  bot={bot}
                  expanded={isExpanded(bot.id)}
                  key={bot.id}
                  onToggle={() => toggle(bot.id)}
                  waiting={waitingOf(bot.id)}
                />
              ))}
            </ul>
          </HeldReads.Provider>
        )}
      </SidebarContent>
    </SectionPanel>
  );
}
