import { IconDots } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { deleteChannelMutationOptions } from "@/lib/channels/mutations";
import { ChannelAvatar } from "../channels/avatar";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * State inside a row is no reason to drop the memo: `memo` compares the props it is handed and has
 * nothing to say about a hook. Dropping it re-renders every row in the roster whenever the sidebar
 * renders, which is the cost the identity-preserving patch in `use-channel-events` exists to avoid.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // `strict: false`: this row renders in the sidebar on every screen, not only while its own
  // channel is open, so there may be no `channelId` route param to read at all.
  const { channelId: openChannelId } = useParams({ strict: false });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));

  const handleDelete = async () => {
    // Navigate away first: the row this menu lives on unmounts the moment the list invalidates,
    // and a screen still pointed at a channel id that no longer resolves is worse than a screen
    // that moved on a beat early.
    if (openChannelId === channelId) {
      await navigate({ to: "/" });
    }
    try {
      await deleteChannel.mutateAsync(channelId);
      /*
       * Closed on success rather than left to the unmount.
       *
       * The row does go away when the roster invalidates, taking this dialog with it, but that is a
       * side effect of a cache write and not something this component controls.
       */
      setDeleteDialogOpen(false);
    } catch {
      /*
       * Left open, deliberately. A delete that failed leaves the row exactly where it was, so
       * closing would return the person to a roster that still lists the conversation they just
       * asked to be rid of, with nothing anywhere saying why. The message is rendered below;
       * `mutateAsync` rejects rather than swallowing, which is why this catch exists at all.
       */
    }
  };

  return (
    <div className="group/channel relative">
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
            <span className="text-[14px] tracking-[-1%] truncate">{name}</span>
            <div className="group-hover/channel:invisible text-[12px] text-muted-foreground/70">
              {lastMessageAt}
            </div>
          </div>
          <div className="mt-px flex h-4 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
              {lastMessage}
            </span>
          </div>
        </div>
      </Link>
      <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/channel:opacity-100 focus-within:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Options for ${name}`}
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {/* Only opens the dialog below; the menu closes on click, too early to confirm anything. */}
              <DropdownMenuItem
                onClick={() => setDeleteDialogOpen(true)}
                variant="destructive"
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes your conversation with{" "}
              <span className="font-medium text-foreground">{name}</span>,
              including its message history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteChannel.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteChannel.isPending}>
              Cancel
            </AlertDialogCancel>
            {/*
             * A plain button, not `AlertDialogAction`.
             *
             * That one renders the primitive's `Close`, so it shuts the dialog the instant it is
             * pressed, before the request it starts has been answered. Nothing then reports a
             * delete that failed: the dialog is gone, the conversation is still in the roster, and
             * the person is left to work out for themselves that the thing they asked for did not
             * happen. It also means "Deleting…" below could never appear.
             */}
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => void handleDelete()}
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
