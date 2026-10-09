import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";

/** Questions, approvals and stalled hand-offs: the things only the person can move forward. */
export function needsInput(bot: BotAttention): number {
  return bot.questions + bot.approvals + bot.handoffs;
}

/** What the badge says, in words, for the row's accessible name and its tooltip. */
export function attentionSummary(bot: BotAttention): string {
  const parts: string[] = [];
  if (bot.questions)
    parts.push(`${bot.questions} question${bot.questions === 1 ? "" : "s"}`);
  if (bot.approvals)
    parts.push(`${bot.approvals} approval${bot.approvals === 1 ? "" : "s"}`);
  if (bot.handoffs)
    parts.push(
      `${bot.handoffs} stalled hand-off${bot.handoffs === 1 ? "" : "s"}`,
    );
  if (bot.unread) parts.push(`${bot.unread} unread`);
  return parts.join(", ");
}

/**
 * A browser notification when a Bot starts needing this person, if they allowed notifications and
 * did not mute this Bot. Badges show either way; this is the interruption, and it is opt-in.
 */
function useAttentionNotifications(bots: BotAttention[] | undefined) {
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!bots) return;
    const previous = seen.current;
    seen.current = new Map(bots.map((bot) => [bot.agentId, needsInput(bot)]));
    // The first answer is the state on arrival, not news.
    if (!previous) return;
    let permitted = false;
    try {
      permitted =
        typeof Notification !== "undefined" &&
        Notification.permission === "granted";
    } catch {
      permitted = false;
    }
    if (!permitted) return;
    for (const bot of bots) {
      const now = needsInput(bot);
      if (bot.notify === "none" || now <= (previous.get(bot.agentId) ?? 0))
        continue;
      try {
        new Notification(`${bot.name} needs you`, {
          body: attentionSummary(bot),
          tag: `openbot-attention-${bot.agentId}`,
        });
      } catch {
        // A browser that refuses the constructor still has the badge.
      }
    }
  }, [bots]);
}

/**
 * The badge on the sidebar's Bots item: how many questions, approvals and stalled hand-offs wait on
 * this person across all their Bots, or a dot when the only news is something unread. Opening Bots
 * lists the Bots behind the number first, under Needs you.
 *
 * It also sends the browser notification when a Bot starts needing the person, since it is the one
 * piece of the app that is always on screen and always reading this.
 *
 * Renders nothing when nothing is waiting, so a quiet day costs the sidebar nothing.
 */
export function BotsNavBadge() {
  const attention = useQuery(botAttentionQueryOptions());
  useAttentionNotifications(attention.data);
  const bots = attention.data ?? [];
  const waiting = bots.reduce((total, bot) => total + needsInput(bot), 0);
  if (waiting > 0) {
    return (
      <span
        aria-label={`${waiting} ${waiting === 1 ? "thing needs" : "things need"} you`}
        className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums"
      >
        {waiting}
      </span>
    );
  }
  if (bots.some((bot) => bot.unread > 0)) {
    return (
      <span
        aria-label="Unread messages"
        className="ml-auto size-2 rounded-full bg-primary"
        role="img"
      />
    );
  }
  return null;
}
