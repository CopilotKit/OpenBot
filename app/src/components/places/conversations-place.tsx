import { useInfiniteQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { RefObject } from "react";
import {
  ConversationRoster,
  isUnread,
} from "@/components/app-sidebar/conversation-roster";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { type PlaceEntry, StripBadge } from "./place-row";

export function ConversationsPlace({
  scrollRoot,
}: {
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  return <ConversationRoster scrollRoot={scrollRoot} dense />;
}

/** A dot on the Conversations button while any conversation but the open one has unseen activity. */
export function ConversationsBadge() {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const openChannelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const unread = channels.data?.some((channel) =>
    isUnread(channel, openChannelId),
  );
  return unread ? <StripBadge dot /> : null;
}

export const conversationsPlace: PlaceEntry | undefined = {
  List: ConversationsPlace,
  Badge: ConversationsBadge,
};
