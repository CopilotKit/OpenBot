import { IconPin, IconPinnedOff, IconTrash } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { DeleteConversationDialog } from "./delete-conversation-dialog";

/**
 * Pin and Delete for the conversation that is open, in the Bot panel beside it.
 *
 * The same two actions as the sidebar row's right-click menu, which nobody finds without being told
 * it is there. Navigation is the caller's: `leave` takes the person off the conversation before it
 * is deleted from under them.
 *
 * Whether it is pinned comes from the sidebar's list, which is already loaded, because the
 * conversation's own read does not carry the member's pin. The list's first page always holds every
 * pinned conversation, so a conversation missing from the pages loaded so far is not pinned.
 */
export function ConversationActions({
  channelId,
  leave,
  name,
}: {
  channelId: string;
  leave: () => Promise<unknown>;
  name: string;
}) {
  const queryClient = useQueryClient();
  const pinned = useInfiniteQuery({
    ...channelListQueryOptions(),
    select: (data) =>
      data.pages.some((page) =>
        page.channels.some(
          (channel) => channel.id === channelId && channel.pinned,
        ),
      ),
  }).data;
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="grid gap-2">
      {/* Headed like the profile's own sections, so it reads as about the conversation, not the Bot. */}
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        This conversation
      </h2>
      <div className="flex flex-col gap-2">
        {/* The heading names the conversation, so the labels drop it; screen readers still hear it. */}
        <Button
          aria-label={pinned ? "Unpin conversation" : "Pin conversation"}
          className="w-full text-sm!"
          disabled={pinned === undefined || setPinned.isPending}
          onClick={() => setPinned.mutate({ channelId, pinned: !pinned })}
          variant="outline"
        >
          {pinned ? <IconPinnedOff /> : <IconPin />}
          {pinned ? "Unpin" : "Pin"}
        </Button>
        <Button
          aria-label="Delete conversation…"
          className="w-full text-sm!"
          onClick={() => setConfirming(true)}
          variant="destructive"
        >
          <IconTrash />
          Delete…
        </Button>
      </div>
      {/* No toast in this app: why a pin did not take is said where it was asked for. */}
      {setPinned.error ? (
        <p className="text-destructive text-xs" role="alert">
          {setPinned.error.message}
        </p>
      ) : null}
      <DeleteConversationDialog
        channelId={channelId}
        leave={leave}
        name={name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </section>
  );
}
