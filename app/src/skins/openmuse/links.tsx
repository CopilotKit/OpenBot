import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { mainChannel } from "./model";

type AnchorProps = Omit<React.ComponentProps<"a">, "href">;

/**
 * A link to a Bot's main chat: its one-to-one conversation when it has one, otherwise a new
 * conversation already addressed to it. Both are OpenBot's own chat routes.
 */
export function MainChatLink({
  agentId,
  ...props
}: AnchorProps & { agentId: string | undefined }) {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const main = mainChannel(agentId, channels.data);
  if (main) {
    return (
      <Link
        {...props}
        params={{ channelId: main.id }}
        to="/channel/$channelId"
      />
    );
  }
  return (
    <Link
      {...props}
      search={agentId ? { agent: agentId } : {}}
      to="/channel/new"
    />
  );
}

/** A new conversation with this Bot: OpenMuse's "new side chat". */
export function NewChatLink({
  agentId,
  ...props
}: AnchorProps & { agentId: string | undefined }) {
  return (
    <Link
      {...props}
      search={agentId ? { agent: agentId } : {}}
      to="/channel/new"
    />
  );
}
