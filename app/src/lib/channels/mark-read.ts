import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { markChannelReadMutationOptions } from "./mutations";
import { channelListQueryOptions } from "./queries";

/**
 * Opening a conversation marks it read; a Bot replying while it is open marks it read again. Used by
 * every screen that shows one conversation, one Bot or several.
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
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) markReadMutate(channelId);
  }, [channelId, unseen, markReadMutate]);
}
