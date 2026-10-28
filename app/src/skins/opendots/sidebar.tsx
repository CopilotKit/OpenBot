import {
  IconBook,
  IconClockHour3,
  IconDots,
  IconLogout,
  IconMessageCircle,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { memoriesQueryOptions } from "@/lib/memory";
import { useNavigationItems } from "@/lib/navigation";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import type { Place } from "./place";

/** OpenDots' sidebar row: a quiet line of text that lights lavender when it is the page. */
export const navItem =
  "flex w-full min-w-0 items-center gap-[11px] rounded-[7px] px-3.5 py-3 text-left text-[13px] leading-snug text-(--opendots-nav-ink) outline-none transition-colors hover:bg-(--opendots-hover) focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[17px] [&_svg]:shrink-0 [&_svg]:stroke-[1.65]";
export const navItemActive =
  "bg-(--opendots-active) text-(--opendots-active-ink) hover:bg-(--opendots-active) [&_svg]:stroke-2";

/** The small grey heading over a group of rows, with its one or two actions on the right. */
function NavLabel({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-[5px] flex min-h-[26px] items-center justify-between pr-[3px] pl-3.5 text-[10px] font-semibold text-(--opendots-label)",
        className,
      )}
    >
      <span>{children}</span>
      {actions ? (
        <span className="flex items-center gap-0.5">{actions}</span>
      ) : null}
    </div>
  );
}

/** OpenDots' bare icon button: no frame, a grey glyph, a soft square on hover. */
export function IconAction({
  label,
  children,
  className,
  ...props
}: {
  label: string;
  children: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button
      aria-label={label}
      className={cn(
        "size-7 rounded-[7px] text-(--opendots-icon) hover:bg-(--opendots-hover) hover:text-foreground [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      size="icon-sm"
      title={label}
      variant="ghost"
      {...props}
    >
      {children}
    </Button>
  );
}

/**
 * The deployment's own name, set in OpenDots' wordmark type, which is also the way home. The name
 * is `brand.yaml`'s, the same one OpenBot's sidebar header shows; a skin changes the look, never
 * whose product it is.
 */
function Wordmark({ onNavigate }: { onNavigate: () => void }) {
  const productName = appConfig.brand.productName;
  return (
    <Link
      aria-label={`${productName} home`}
      className="mb-[23px] flex h-[18px] min-w-0 items-center self-start rounded-lg px-2.5 text-[16px] leading-[18px] font-bold tracking-[-0.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="opendots-wordmark"
      onClick={onNavigate}
      to="/"
    >
      <span className="truncate">{productName}</span>
    </Link>
  );
}

/**
 * The most recent conversation this person has with one Bot alone, from the roster already loaded.
 * Choosing a Dot in OpenDots reopens where you left off with it, and only starts fresh when there
 * is nowhere to go back to.
 */
export function latestChannelWith(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary | undefined {
  let latest: ChannelSummary | undefined;
  let latestAt = "";
  for (const channel of channels ?? []) {
    if (channel.agentIds.length !== 1 || channel.agentIds[0] !== agentId)
      continue;
    const at = channel.lastMessageAt ?? channel.createdAt;
    if (at > latestAt) {
      latest = channel;
      latestAt = at;
    }
  }
  return latest;
}

/** The Bots a person can talk to, pinned and assigned first, then their own, then shared ones. */
export function dotOrder(agents: readonly AgentProfile[]): AgentProfile[] {
  const roster = groupRoster(agents);
  return [...roster.pinned, ...roster.yours, ...roster.shared];
}

function BotsSection({
  place,
  channels,
  onNavigate,
}: {
  place: Place;
  channels: ChannelSummary[] | undefined;
  onNavigate: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const dots = agents.data ? dotOrder(agents.data) : [];
  const bots = useNavigationItems().find((item) => item.id === "bots");
  return (
    <section aria-label="Bots">
      <NavLabel
        actions={
          <IconAction
            label="Create Bot"
            onClick={onNavigate}
            render={(props) => (
              <Link {...props} search={{ new: true }} to="/bots" />
            )}
          >
            <IconPlus />
          </IconAction>
        }
      >
        BOTS
      </NavLabel>
      {agents.isPending ? null : agents.error ? (
        <p className="px-3.5 py-1.5 text-[12px] text-destructive" role="alert">
          Couldn't load your Bots. Reload the page.
        </p>
      ) : dots.length === 0 ? (
        <p className="px-3.5 py-1.5 text-[12px] leading-relaxed text-(--opendots-faint)">
          No Bots yet. Use + to create one.
        </p>
      ) : (
        <nav
          aria-label="Your Bots"
          className="grid max-h-[32vh] gap-[3px] overflow-y-auto"
        >
          {dots.map((agent) => {
            const latest = latestChannelWith(channels, agent.id);
            const active = place.section === "chat" && place.botId === agent.id;
            return (
              <div className="flex items-center gap-0.5" key={agent.id}>
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    navItem,
                    "min-h-[42px] gap-[9px] px-2.5 py-1.5 text-[12px] text-(--opendots-dot-ink) hover:bg-(--opendots-hover)",
                    // The row's only drawing is the avatar, which keeps its own size.
                    "[&_svg]:size-full",
                    active &&
                      "bg-(--opendots-active) hover:bg-(--opendots-active)",
                  )}
                  data-testid="opendots-bot"
                  onClick={onNavigate}
                  {...(latest
                    ? {
                        to: "/channel/$channelId",
                        params: { channelId: latest.id },
                      }
                    : { to: "/channel/new", search: { agent: agent.id } })}
                >
                  {/* OpenBot's own avatar for the Bot; hidden so the row is named once. */}
                  <span aria-hidden className="contents">
                    <AbstractAvatar
                      name={agent.name}
                      seed={agent.avatarSeed}
                      size={30}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                </Link>
                <IconAction
                  label={`Open ${agent.name}'s settings`}
                  onClick={onNavigate}
                  render={(props) => (
                    <Link
                      {...props}
                      params={{ agentId: agent.id }}
                      to="/bots/$agentId"
                    />
                  )}
                >
                  <IconDots className="size-[15px]" />
                </IconAction>
              </div>
            );
          })}
        </nav>
      )}
      {bots ? (
        // OpenBot's Bots destination, from the shared list, closing the list of Bots above it.
        <Link
          activeOptions={{ exact: true }}
          activeProps={{ className: navItemActive, "aria-current": "page" }}
          className={cn(navItem, "mt-[3px] py-2.5 text-(--opendots-dot-ink)")}
          onClick={onNavigate}
          to={bots.to}
        >
          <bots.icon />
          <span className="min-w-0 flex-1 truncate">All {bots.label}</span>
        </Link>
      ) : null}
    </section>
  );
}

function ThreadRow({
  channel,
  names,
  open,
  onNavigate,
}: {
  channel: ChannelSummary;
  names: string;
  open: boolean;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const [pinProblem, setPinProblem] = useState<string | null>(null);
  const unread = isUnread(channel, open ? channel.id : undefined);
  const title = channel.summary || channel.lastMessage || channel.name;
  const link: LinkProps =
    channel.agentIds.length > 1
      ? { to: "/group/$channelId", params: { channelId: channel.id } }
      : { to: "/channel/$channelId", params: { channelId: channel.id } };
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            {...link}
            aria-current={open ? "page" : undefined}
            className={cn(
              navItem,
              "mb-1 gap-[11px] px-3 py-[9px] [&_svg]:size-[15px]",
              open && navItemActive,
            )}
            data-testid="opendots-thread"
            onClick={onNavigate}
          >
            <IconMessageCircle />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate">{title}</span>
              <small className="truncate bg-(--opendots-tag) text-[11px] leading-[1.4] text-(--opendots-tag-ink)">
                {names}
              </small>
            </span>
            {channel.pinned ? (
              <IconPin
                aria-label="Pinned"
                className="size-3! text-(--opendots-faint)"
              />
            ) : null}
            {unread ? (
              <span
                aria-label="Unread"
                className="size-1.5 shrink-0 rounded-full bg-(--opendots-teal)"
                role="img"
              />
            ) : null}
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              setPinned.mutate(
                { channelId: channel.id, pinned: !channel.pinned },
                { onError: (thrown) => setPinProblem(thrown.message) },
              );
            }}
          >
            {channel.pinned ? <IconPinnedOff /> : <IconPin />}
            {channel.pinned ? "Unpin conversation" : "Pin conversation"}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => setConfirming(true)}
            variant="destructive"
          >
            <IconTrash />
            Delete conversation…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-3 pb-1 text-[11px] text-destructive" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channel.id}
        leave={open ? () => navigate({ to: "/" }) : undefined}
        name={channel.name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </>
  );
}

function RecentChats({
  place,
  newChat,
  onNavigate,
}: {
  place: Place;
  newChat: LinkProps;
  onNavigate: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const scrollRoot = useRef<HTMLDivElement>(null);
  const visible = pinnedFirst(matchingChannels(channels.data, search));
  const nameOf = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name;
  const closeSearch = () => {
    setSearching(false);
    setSearch("");
  };
  return (
    <section
      aria-label="Recent chats"
      className="mt-4 flex min-h-0 flex-1 flex-col max-md:flex-none"
    >
      <NavLabel
        actions={
          <>
            <IconAction
              aria-pressed={searching}
              label={searching ? "Close search" : "Search conversations"}
              onClick={() => (searching ? closeSearch() : setSearching(true))}
            >
              {searching ? <IconX /> : <IconSearch />}
            </IconAction>
            <IconAction
              label="New conversation"
              onClick={onNavigate}
              render={(props) => <Link {...props} {...newChat} />}
            >
              <IconPlus />
            </IconAction>
          </>
        }
        className="mt-[18px]"
      >
        RECENT CHATS
      </NavLabel>
      {searching ? (
        <div className="mb-2 px-1">
          <Input
            aria-label="Search conversations"
            autoFocus
            className="h-8 rounded-[9px] bg-background text-[13px]"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
            }}
            placeholder="Find a conversation…"
            value={search}
          />
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto max-md:max-h-[27vh]"
        ref={scrollRoot}
      >
        {channels.isPending ? null : channels.error ? (
          <p className="px-3.5 py-1.5 text-[12px] text-(--opendots-error-ink)">
            Couldn't load your conversations. Reload the page.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-3.5 py-1.5 text-[12px] leading-relaxed text-(--opendots-faint)">
            {search.trim()
              ? `No conversation has “${search.trim()}” in its name or latest message.`
              : "No conversations yet. Start one with New chat."}
          </p>
        ) : (
          visible.map((channel) => (
            <ThreadRow
              channel={channel}
              key={channel.id}
              names={channel.agentIds
                .map((id) => nameOf(id))
                .filter(Boolean)
                .join(", ")}
              onNavigate={onNavigate}
              open={place.channelId === channel.id}
            />
          ))
        )}
        {/* OpenBot's own pager: it loads older conversations as the list scrolls to its end. */}
        <ChannelPagination
          query={channels}
          scrollRoot={scrollRoot}
          searching={search.trim().length > 0}
        />
      </div>
    </section>
  );
}

function Count({ value }: { value: number | undefined }) {
  if (!value) return null;
  return (
    <small className="bg-(--opendots-tag) text-[10px] text-(--opendots-tag-ink) tabular-nums">
      {value}
    </small>
  );
}

function WorkspaceLinks({
  place,
  onNavigate,
}: {
  place: Place;
  onNavigate: () => void;
}) {
  const routines = useQuery(routinesQueryOptions());
  const memories = useQuery(memoriesQueryOptions());
  // OpenDots keeps these rows in the chrome's olive ink; the row you are on only gains the tint.
  const row = (section: string) =>
    cn(
      navItem,
      "text-(--opendots-dot-ink)",
      place.section === section &&
        "bg-(--opendots-active) hover:bg-(--opendots-active) [&_svg]:stroke-2",
    );
  const current = (section: Place["section"]) =>
    place.section === section ? ("page" as const) : undefined;
  /*
   * OpenDots' sidebar ends on a few rows. OpenBot's primary destinations and the person's own menu
   * are in the rail at desktop width, so they join these rows only in the phone drawer, where there
   * is no rail. Bots is the row under the list of Bots above.
   */
  const drawerOnly = "md:hidden";
  const navigation = useNavigationItems().filter((item) => item.id !== "bots");
  return (
    <nav
      aria-label="Workspace"
      className="mt-auto border-t border-(--opendots-line) pt-2.5"
    >
      <Link
        aria-current={current("routines")}
        className={row("routines")}
        onClick={onNavigate}
        params={{ screen: "routines" }}
        to="/s/$screen"
      >
        <IconClockHour3 />
        <span className="min-w-0 flex-1 truncate">Routines</span>
        <Count value={routines.data?.routines.length} />
      </Link>
      <Link
        aria-current={current("memories")}
        className={row("memories")}
        onClick={onNavigate}
        params={{ screen: "memories" }}
        to="/s/$screen"
      >
        <IconBook />
        <span className="min-w-0 flex-1 truncate">Memories</span>
        <Count value={memories.data?.length} />
      </Link>
      {/* OpenBot's own destinations, from the one list every frame reads. */}
      {navigation.map((item) => (
        <Link
          aria-current={place.section === item.id ? "page" : undefined}
          className={cn(row(item.id), item.section === "primary" && drawerOnly)}
          key={item.id}
          onClick={onNavigate}
          to={item.to}
        >
          <item.icon />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </Link>
      ))}
      <UserRow />
    </nav>
  );
}

export function initialsOf(user: { name?: string | null; email: string }) {
  return (
    user.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || user.email.slice(0, 2).toUpperCase()
  );
}

/** Who is signed in, and the way out. OpenBot's sidebar keeps this in its user menu. */
function UserRow() {
  const user = useQuery(currentUserQueryOptions());
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  if (!user.data) return null;
  const name = user.data.name?.trim() || user.data.email;
  const initials = initialsOf(user.data);
  return (
    <div className="mt-1.5 flex items-center gap-2.5 px-2.5 pt-1.5 md:hidden">
      <span
        aria-hidden
        className="grid size-[29px] shrink-0 place-items-center rounded-full border border-(--opendots-avatar-line) bg-(--opendots-avatar) text-[10px] text-(--opendots-avatar-ink)"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-(--opendots-muted)">
        {name}
      </span>
      <IconAction
        disabled={signOut.isPending}
        label="Sign out"
        onClick={async () => {
          await signOut.mutateAsync();
          await navigate({ to: "/sign" });
        }}
      >
        <IconLogout />
      </IconAction>
    </div>
  );
}

/**
 * OpenDots' sidebar over OpenBot's data: the Bots as Dots, the conversations as recent chats, and
 * the workspace views beneath. Every OpenBot surface the default sidebar reaches is here too.
 */
export function OpenDotsSidebar({
  place,
  newChat,
  onNavigate,
}: {
  place: Place;
  newChat: LinkProps;
  onNavigate: () => void;
}) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-[23px] pb-3 max-md:overflow-y-auto">
      <Wordmark onNavigate={onNavigate} />
      <Link
        {...newChat}
        className={cn(
          navItem,
          "mb-[26px] text-(--opendots-new-chat-ink) hover:bg-(--opendots-hover)",
        )}
        onClick={onNavigate}
      >
        <IconPlus />
        <span>New chat</span>
      </Link>
      <BotsSection
        channels={channels.data}
        onNavigate={onNavigate}
        place={place}
      />
      <RecentChats newChat={newChat} onNavigate={onNavigate} place={place} />
      <WorkspaceLinks onNavigate={onNavigate} place={place} />
    </div>
  );
}
