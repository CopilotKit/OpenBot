import { IconArrowsExchange } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BoardRow } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import {
  type ActivityItem,
  botActivityQueryOptions,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { relativeTime } from "@/lib/relative-time";

/** A hand-off a Bot asked for that ran out of tries: only the person can pick it up. */
export type StalledHandoff = { botId: string; item: ActivityItem };

/**
 * Every stalled hand-off the Bots badge counts, as rows to list: the badge counts them per Bot
 * (`handoffs` on what the server says each Bot waits on), and each one is read from that Bot's own
 * Activity, where it is the item that needs the person. Given a Bot, only that Bot's. Read only for
 * a Bot the badge counts one for, so a quiet day reads nothing.
 */
export function useStalledHandoffs(agentId?: string): StalledHandoff[] {
  const attention = useQuery(botAttentionQueryOptions());
  const asking = (attention.data ?? [])
    .filter(
      (bot) =>
        bot.handoffs > 0 && (agentId === undefined || bot.botId === agentId),
    )
    .map((bot) => bot.botId);
  const reads = useQueries({
    queries: asking.map((botId) => botActivityQueryOptions(botId)),
  });
  const seen = new Set<string>();
  const stalled: StalledHandoff[] = [];
  asking.forEach((botId, at) => {
    for (const item of reads[at]?.data?.inProgress ?? []) {
      if (item.kind !== "handoff" || !item.needsYou || seen.has(item.id))
        continue;
      seen.add(item.id);
      stalled.push({ botId, item });
    }
  });
  return stalled;
}

/** A stalled hand-off on the Needs you board, in the board's one row shape, with Open into it. */
export function StalledHandoffBoardRow({
  stalled,
}: {
  stalled: StalledHandoff;
}) {
  const { item } = stalled;
  const { channelId } = item;
  return (
    <BoardRow
      actions={
        channelId ? (
          <Button
            render={<Link params={{ channelId }} to="/channel/$channelId" />}
            size="sm"
          >
            Open
          </Button>
        ) : (
          <Button
            render={
              <Link
                params={{ agentId: stalled.botId }}
                to="/bots/$agentId/activity"
              />
            }
            size="sm"
          >
            Open
          </Button>
        )
      }
      detail={item.detail}
      icon={<IconArrowsExchange />}
      meta={[
        <span key="status">Stalled hand-off</span>,
        <span key="when">{relativeTime(item.at)}</span>,
      ]}
      state="stalled"
      title={item.title}
      waiting
    />
  );
}
