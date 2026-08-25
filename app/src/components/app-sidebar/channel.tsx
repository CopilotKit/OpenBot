import {
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteChannelMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import { ChannelAvatar } from "../channels/avatar";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin and Delete. Deleting is confirmed in a dialog that names the channel,
 * because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
  pinned,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
  pinned: boolean;
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
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);

  const confirmDelete = async () => {
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setConfirming(false);
    if (isOpen) {
      await navigate({ to: "/" });
    }
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            to="/channel/$channelId"
            params={{ channelId }}
            type="button"
            className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
            activeProps={{
              className: "bg-foreground/5",
            }}
          >
            <div className="">
              <ChannelAvatar participantIds={participantIds} size={32} />
            </div>
            <div className="flex-col min-w-0 flex-1">
              <div className="flex flex-row items-center justify-between gap-2">
                <span className="text-[14px] tracking-[-1%] truncate">
                  {name}
                </span>
                <div className="text-[12px] text-muted-foreground/70">
                  {lastMessageAt}
                </div>
              </div>
              <div className="mt-px flex h-4 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
                  {lastMessage}
                </span>
                {pinned ? (
                  <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
              </div>
            </div>
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => setPinned.mutate({ channelId, pinned: !pinned })}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin channel" : "Pin channel"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => setConfirming(true)}
          >
            <IconTrash />
            Delete channel…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
