import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { inSight } from "@/lib/notifications/show";
import { markChannelReadMutationOptions } from "./mutations";
import { channelListQueryOptions } from "./queries";

/**
 * Whether OpenBot is in front of the person now (`inSight`: its page shown and its window focused),
 * kept current as they switch away and back.
 */
function useInSight(): boolean {
  const [seen, setSeen] = useState(inSight);
  useEffect(() => {
    const update = () => setSeen(inSight());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return seen;
}

/**
 * Opening a conversation marks it read; a Bot replying while it is open marks it read again. Used by
 * every screen that shows one conversation, one Bot or several.
 *
 * ONLY WHILE THE PERSON CAN SEE IT. A conversation left open in a window behind others, or in OpenBot
 * Desktop while the person is away from the computer, is not read: what the Bot said there waits as
 * unread until they come back to it. The server tells the person's phone about an answer that is
 * still unread a while after it ended, so marking it read unseen would keep that from them.
 *
 * Read off the roster the sidebar renders, since the socket keeps its lastMessageAt live: it is the
 * one honest source for "has something new been said". Keyed on primitives, deliberately: the
 * optimistic patch changes the row OBJECT without changing these values, so an object dependency
 * would re-fire on its own write — and with lastMessageAt ahead of this browser's clock, loop.
 */
export function useMarkOpenChannelRead(channelId: string) {
  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const seen = useInSight();
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen && seen) markReadMutate(channelId);
  }, [channelId, unseen, seen, markReadMutate]);
}
