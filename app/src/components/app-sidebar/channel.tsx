import {
  IconDots,
  IconPin,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuAction, SidebarMenuItem } from "@/components/ui/sidebar";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { useTypedReveal } from "@/lib/typed-reveal";
import { ChannelItemContent } from "./channel-item-content";

/*
 * A row lifts to the card's fill and shadow under the pointer, while it is the open conversation,
 * and while its own menu is open, so the menu points at the row it is about. `--avatar-ground`
 * keeps the busy dot's ring the colour of the row it sits on. The sidebar's other controls light
 * the same way.
 */
export const LIT =
  "bg-sidebar-accent shadow-(--shadow-card) [--avatar-ground:var(--sidebar-accent)]";
const rowClassName = [
  "flex w-full flex-row items-center gap-2 rounded-lg px-2 py-2 outline-hidden [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]",
  "hover:bg-sidebar-accent hover:shadow-(--shadow-card) hover:[--avatar-ground:var(--sidebar-accent)]",
  "group-has-[[data-sidebar=menu-action][aria-expanded=true]]/menu-item:bg-sidebar-accent group-has-[[data-sidebar=menu-action][aria-expanded=true]]/menu-item:shadow-(--shadow-card) group-has-[[data-sidebar=menu-action][aria-expanded=true]]/menu-item:[--avatar-ground:var(--sidebar-accent)]",
  "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
  // Under 768px the "…" button always shows, so the row keeps room for it.
  "max-md:pr-9",
].join(" ");

/** Pin and Delete, the same two in the row's right-click menu and in its "…" menu. */
function ConversationMenuItems({
  item: Item,
  pinned,
  onPin,
  onDelete,
}: {
  item: typeof ContextMenuItem | typeof DropdownMenuItem;
  pinned: boolean;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <Item onClick={onPin}>
        {pinned ? <IconPinnedOff /> : <IconPin />}
        {pinned ? "Unpin conversation" : "Pin conversation"}
      </Item>
      <Item variant="destructive" onClick={onDelete}>
        <IconTrash />
        Delete conversation…
      </Item>
    </>
  );
}

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Pin and Delete open from right-click, and from the "…" button over the row's end. Right-click
 * alone was found by nobody who was not told, and reached by no keyboard. The button shows under
 * the pointer and while focus is in the row, and comes straight after it in tab order. Deleting is
 * confirmed in a dialog that names the channel, because the row it was invoked on is one of several
 * identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  summary,
  lastMessage,
  lastMessageAt,
  pinned,
  unread,
  busy,
  emphasis,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  /** What the conversation is about, once named. The channel name only says which Bot it is. */
  summary?: string;
  /** Used as the thread title until the conversation has been named. */
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
  unread: boolean;
  busy: boolean;
  emphasis: MessageListEmphasis;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  /* Types in only on arrival; an already-named row draws it outright. */
  const revealed = useTypedReveal(summary);
  const threadTitle = revealed.text || lastMessage || "New conversation";
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  const title = summary || lastMessage || "New conversation";
  const pin = () => {
    setPinProblem(null);
    setPinned.mutate(
      { channelId, pinned: !pinned },
      { onError: (thrown) => setPinProblem(thrown.message) },
    );
  };
  const askToDelete = () => setConfirming(true);

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            // Two or more Bots is a group conversation, which has its own shared transcript.
            to={
              participantIds.length > 1
                ? "/group/$channelId"
                : "/channel/$channelId"
            }
            params={{ channelId }}
            type="button"
            className={rowClassName}
            activeProps={{ className: LIT }}
          >
            <ChannelItemContent
              participantIds={participantIds}
              name={name}
              title={title}
              displayedTitle={threadTitle}
              lastMessageAt={lastMessageAt}
              emphasis={emphasis}
              busy={busy}
              unread={unread}
              pinned={pinned}
              revealing={revealed.typing}
            />
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ConversationMenuItems
            item={ContextMenuItem}
            onDelete={askToDelete}
            onPin={pin}
            pinned={pinned}
          />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              aria-label={`Options for ${title}`}
              // On the first line, over the time that steps aside for it; 24px, the smallest target.
              className="top-1.5 right-1.5 size-6 text-muted-foreground hover:bg-sidebar aria-expanded:bg-sidebar aria-expanded:text-sidebar-foreground"
              showOnHover
            />
          }
        >
          <IconDots />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <ConversationMenuItems
            item={DropdownMenuItem}
            onDelete={askToDelete}
            onPin={pin}
            pinned={pinned}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channelId}
        // Away first when this row's channel is the one on screen.
        leave={isOpen ? () => navigate({ to: "/" }) : undefined}
        name={name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </SidebarMenuItem>
  );
});
