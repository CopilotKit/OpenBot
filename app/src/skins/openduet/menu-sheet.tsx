import {
  IconChevronRight,
  IconLogout,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlus,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { isUnread, pinnedFirst } from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import { needsInput } from "@/components/bot-profile/attention";
import { ChannelAvatar } from "@/components/channels/avatar";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { useNavigationItems } from "@/lib/navigation";
import { relativeTime } from "@/lib/relative-time";
import { useMessageListEmphasis } from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { FOCUS } from "./kit";

/** Whether Manage was left open, kept in this browser between visits. */
export const MANAGE_STORAGE_KEY = "openduet.menu-manage";

function rememberedOpen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "open";
  } catch {
    return false;
  }
}

function rememberOpen(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Storage can be refused. The group still opens; it just starts closed next time.
  }
}

/** A row in the menu: a line glyph and the place's name, at least 48px tall. */
const ROW = cn(
  "openduet-type-nav flex min-h-12 w-full items-center gap-3 rounded-[22px] px-3 font-medium text-openduet-ink transition-colors duration-[120ms] motion-reduce:transition-none hover:bg-openduet-tile active:bg-openduet-tile [&_svg]:shrink-0 [&>svg]:text-openduet-ink-2",
  FOCUS,
);
/** A row with a disc, a name and a line under it: Chat and each conversation. */
const TALL_ROW = cn(
  "flex min-h-[52px] w-full items-center gap-3 rounded-[24px] px-2.5 py-1.5 text-left hover:bg-openduet-tile",
  FOCUS,
);
const HERE = { className: "bg-openduet-tile" };

/**
 * The drawer behind the header's left disc. From the top: the product's name and who is signed in;
 * Chat, where a conversation starts; every conversation OpenBot keeps for this person, pinned first
 * and newest after, joined to Chat by a hairline; New conversation; then the pages that set things
 * up, under Manage, closed until somebody opens it; and Settings on its own, never folded, because
 * the skin picker is there.
 *
 * The conversations take the height that is left and scroll by themselves, so the rows above and
 * below stay put, and older ones load as the list nears its end, as OpenBot's sidebar does.
 */
export function MenuSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { data: user } = useQuery(currentUserQueryOptions());
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [manageOpen, setManageOpen] = useState(() =>
    rememberedOpen(MANAGE_STORAGE_KEY),
  );
  const manageId = useId();
  const scrollRoot = useRef<HTMLDivElement>(null);
  const close = () => onOpenChange(false);
  const conversations = pinnedFirst(channels.data ?? []);
  // OpenBot's one navigation list, for this person: Settings on its own, the rest under Manage.
  const navigation = useNavigationItems();
  const settings = navigation.find((item) => item.id === "settings");
  const places = navigation.filter((item) => item.id !== "settings");

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      {/* No close button: the drawer closes on the screen beside it, on Escape, and on a row. */}
      <SheetContent
        className="w-[340px] max-w-[calc(100vw-48px)] gap-0 border-openduet-hair bg-openduet-surface p-0 text-openduet-ink sm:max-w-[340px]"
        showCloseButton={false}
        side="left"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="openduet-type-display font-semibold text-openduet-ink">
            {appConfig.brand.productName}
          </SheetTitle>
          <SheetDescription className="openduet-type-sub truncate text-openduet-ink-2">
            {user?.name || user?.email}
          </SheetDescription>
        </SheetHeader>
        <nav
          aria-label="Menu"
          className="flex min-h-0 flex-1 flex-col px-3 pb-4"
        >
          <Link
            activeOptions={{ exact: true }}
            activeProps={HERE}
            className={TALL_ROW}
            onClick={close}
            to="/"
          >
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center text-openduet-accent"
            >
              <IconStack2 size={24} stroke={1.9} />
            </span>
            <RowText line="Start a conversation with any Bot" name="Chat" />
          </Link>
          <div className="mt-1 flex min-h-0 flex-1 flex-col">
            <div
              className="min-h-0 shrink overflow-y-auto overscroll-contain"
              ref={scrollRoot}
            >
              {channels.isPending ? null : channels.error ? (
                <p
                  className="openduet-type-sub px-3 py-2 text-openduet-problem"
                  role="alert"
                >
                  Couldn't load your conversations. Reload the page.
                </p>
              ) : conversations.length > 0 ? (
                /*
                 * Indented under Chat and joined to it by a hairline running down from Chat's glyph:
                 * these are the conversations Chat has held, not places beside it.
                 */
                <ul
                  aria-label="Conversations"
                  className="ml-[21px] flex flex-col border-openduet-ink-3/40 border-l pl-1.5"
                >
                  {conversations.map((channel) => (
                    <li key={channel.id}>
                      <ConversationRow channel={channel} onOpen={close} />
                    </li>
                  ))}
                </ul>
              ) : null}
              <ChannelPagination
                query={channels}
                scrollRoot={scrollRoot}
                searching={false}
              />
            </div>
            <Link
              activeProps={HERE}
              className={cn(ROW, "mt-1 shrink-0")}
              onClick={close}
              to="/channel/new"
            >
              <IconPlus size={22} stroke={1.8} />
              New conversation
            </Link>
          </div>
          <div className="mt-2 flex shrink-0 flex-col border-openduet-hair border-t pt-2">
            <h2>
              <button
                aria-controls={manageId}
                aria-expanded={manageOpen}
                className={ROW}
                onClick={() => {
                  rememberOpen(MANAGE_STORAGE_KEY, !manageOpen);
                  setManageOpen(!manageOpen);
                }}
                type="button"
              >
                <IconChevronRight
                  className={cn(
                    "transition-transform motion-reduce:transition-none",
                    manageOpen && "rotate-90",
                  )}
                  size={22}
                  stroke={1.8}
                />
                Manage
                {/* Closed, the group would hide what waits on the person, so Manage carries it. */}
                {manageOpen ? null : <AccentBadge />}
              </button>
            </h2>
            <div
              className="flex max-h-[40svh] flex-col overflow-y-auto"
              hidden={!manageOpen}
              id={manageId}
            >
              {places.map((place) => (
                <Link
                  activeProps={HERE}
                  className={ROW}
                  key={place.id}
                  onClick={close}
                  to={place.to}
                >
                  <place.icon size={22} stroke={1.8} />
                  {place.label}
                  {place.id === "bots" ? <AccentBadge /> : null}
                </Link>
              ))}
            </div>
            {settings ? (
              <Link
                activeProps={HERE}
                className={ROW}
                onClick={close}
                to={settings.to}
              >
                <settings.icon size={22} stroke={1.8} />
                {settings.label}
              </Link>
            ) : null}
            <button
              className={ROW}
              disabled={signOut.isPending}
              onClick={async () => {
                await signOut.mutateAsync();
                close();
                await navigate({ to: "/sign" });
              }}
              type="button"
            >
              <IconLogout size={22} stroke={1.8} />
              {signOut.isPending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

/**
 * What waits on the person across their Bots, from OpenBot's own count (the number its sidebar's
 * Bots badge shows), in OpenDuet's one badge style: the accent, with what sits on it. A dot when the
 * only news is something unread.
 */
function AccentBadge() {
  const attention = useQuery(botAttentionQueryOptions());
  const bots = attention.data ?? [];
  const waiting = bots.reduce((total, bot) => total + needsInput(bot), 0);
  if (waiting > 0)
    return (
      <span
        aria-label={`${waiting} ${waiting === 1 ? "thing needs" : "things need"} you`}
        className="openduet-type-caption ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-openduet-accent px-1.5 font-semibold text-openduet-on-accent tabular-nums"
        role="img"
      >
        {waiting}
      </span>
    );
  if (bots.some((bot) => bot.unread > 0))
    return (
      <span
        aria-label="Unread messages"
        className="ml-auto size-2 rounded-full bg-openduet-accent"
        role="img"
      />
    );
  return null;
}

/** A name in the row's ink, and one line under it, cut short. */
function RowText({
  name,
  line,
  strong = false,
}: {
  name: ReactNode;
  line: ReactNode;
  strong?: boolean;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span
        className={cn(
          "block truncate text-[18px] text-openduet-ink leading-[22px]",
          strong ? "font-semibold" : "font-medium",
        )}
      >
        {name}
      </span>
      {line ? (
        <span className="block truncate text-[13px] text-openduet-ink-2 leading-[17px]">
          {line}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One conversation: its Bots' avatars on a disc (OpenBot's, from each Bot's seed), then its title and its Bot, in the order the person
 * chose in OpenBot's preferences. A dot when a Bot said something they have not seen; the faces
 * type while a Bot works there. Held down or right-clicked, it pins or deletes, as OpenBot's roster
 * does.
 */
function ConversationRow({
  channel,
  onOpen,
}: {
  channel: ChannelSummary;
  onOpen: () => void;
}) {
  const emphasis = useMessageListEmphasis();
  const navigate = useNavigate();
  const bots = useQuery(agentListQueryOptions());
  // Each Bot's own avatar, drawn from its seed as OpenBot's Bot pages draw it.
  const seeds = channel.agentIds.map(
    (id) => bots.data?.find((bot) => bot.id === id)?.avatarSeed ?? id,
  );
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channel.id,
  });
  const unread = isUnread(channel, isOpen ? channel.id : undefined);
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = channel.summary || channel.lastMessage || "New conversation";
  const when = channel.lastMessageAt
    ? relativeTime(channel.lastMessageAt)
    : null;
  const busy = (channel.busy ?? false) || (channel.work?.length ?? 0) > 0;
  const [name, line] =
    emphasis === "agent"
      ? [channel.name, title]
      : [title, when ? `${channel.name} · ${when}` : channel.name];
  const group = channel.agentIds.length > 1;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            activeProps={HERE}
            className={TALL_ROW}
            onClick={onOpen}
            params={{ channelId: channel.id }}
            to={group ? "/group/$channelId" : "/channel/$channelId"}
          >
            <span className="shrink-0">
              <ChannelAvatar participantIds={seeds} size={28} typing={busy} />
            </span>
            <RowText line={line} name={name} strong={unread} />
            {channel.pinned ? (
              <IconPinFilled
                aria-label="Pinned"
                className="shrink-0 text-openduet-ink-3"
                size={14}
              />
            ) : null}
            {unread ? (
              <span
                aria-label="Unread"
                className="size-2 shrink-0 rounded-full bg-openduet-accent"
                role="img"
              />
            ) : null}
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setProblem(null);
              setPinned.mutate(
                { channelId: channel.id, pinned: !channel.pinned },
                { onError: (thrown) => setProblem(thrown.message) },
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
      {problem ? (
        <p
          className="openduet-type-caption px-3 pb-1 text-openduet-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channel.id}
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={channel.name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </>
  );
}
