import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  type BotAttention,
  botAttentionQueryOptions,
  lastPingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  type ProactiveSuggestion,
  proactiveSuggestionsQueryOptions,
} from "@/lib/proactive";

/**
 * Questions, approvals and stalled hand-offs: the things only the person can move forward, answered
 * on the Bot's own page. A Bot with any of these is listed under Needs you itself. A task waiting on
 * them is listed as the task, so it is not counted here.
 */
export function needsInput(bot: BotAttention): number {
  return bot.questions + bot.approvals + bot.handoffs;
}

/**
 * What this Bot needs the person to answer or decide: what `needsInput` counts, and its tasks
 * waiting on an approval or a question. What a browser notification is about.
 *
 * Every number is added as it comes. The server counts what a task waits on once, as the task
 * needing input, and leaves that approval or question out of `approvals` and `questions`
 * (server/src/activity/activity.ts), so nothing here is counted twice.
 */
export function asksOf(bot: BotAttention): number {
  return needsInput(bot) + bot.tasks.needsInput;
}

/**
 * Everything from this Bot that waits on the person: what `asksOf` counts, the items its check-ins
 * found, and its tasks with a reply to read or a failure to try again.
 */
export function waitingOnYou(bot: BotAttention): number {
  return asksOf(bot) + bot.items + bot.tasks.ready + bot.tasks.failed;
}

const count = (total: number, one: string, many: string) =>
  `${total} ${total === 1 ? one : many}`;

/** What the badge says, in words, for the row's accessible name and its tooltip. */
export function attentionSummary(bot: BotAttention): string {
  const parts: string[] = [];
  if (bot.questions) parts.push(count(bot.questions, "question", "questions"));
  if (bot.approvals) parts.push(count(bot.approvals, "approval", "approvals"));
  if (bot.handoffs)
    parts.push(count(bot.handoffs, "stalled hand-off", "stalled hand-offs"));
  if (bot.tasks.needsInput)
    parts.push(
      count(
        bot.tasks.needsInput,
        "task waiting on you",
        "tasks waiting on you",
      ),
    );
  if (bot.items) parts.push(count(bot.items, "suggestion", "suggestions"));
  if (bot.tasks.ready)
    parts.push(count(bot.tasks.ready, "task to review", "tasks to review"));
  if (bot.tasks.failed)
    parts.push(count(bot.tasks.failed, "failed task", "failed tasks"));
  if (bot.unread) parts.push(`${bot.unread} unread`);
  return parts.join(", ");
}

/** Whether this browser lets OpenBot interrupt. Some browsers throw on the mere question. */
function notificationsAllowed() {
  try {
    return (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    );
  } catch {
    return false;
  }
}

/** A push body is cut here too, so the browser says what the phone says. */
const PING_BODY_LIMIT = 200;

/**
 * What one ping says in the browser, the way a phone push says it: the Bot's name over "One thing
 * needs you: …", or "Your Bots" over "3 things need you: A; B; C" when it folds several Bots' items.
 * `items` are the ones the ping carried that are still open; when the person already acted on all of
 * them in another tab, the notice still says something needs them, without a title it cannot name.
 */
export function pingNotice(
  items: Pick<ProactiveSuggestion, "agentId" | "title">[],
  botName: (agentId: string) => string | undefined,
): { title: string; body: string } {
  const bots = new Set(items.map((item) => item.agentId));
  const only = bots.size === 1 ? botName([...bots][0] ?? "") : undefined;
  const title = only ?? "Your Bots";
  if (items.length === 0) return { title, body: "Something needs you." };
  const body =
    items.length === 1
      ? `One thing needs you: ${items[0]?.title}`
      : `${items.length} things need you: ${items.map((item) => item.title).join("; ")}`;
  return {
    title,
    body:
      body.length > PING_BODY_LIMIT
        ? `${body.slice(0, PING_BODY_LIMIT - 1).trimEnd()}…`
        : body,
  };
}

/**
 * A browser notification when a Bot starts needing this person for a question, an approval, a
 * stalled hand-off or a task waiting on them, if they allowed notifications and did not mute this
 * Bot. Badges show either way; this is the interruption, and it is opt-in.
 *
 * Check-in items are left to the ping: a Bot's items count rising is not news on its own, because
 * the person hears about items at most once an hour, folded across their Bots.
 */
function useAttentionNotifications(bots: BotAttention[] | undefined) {
  const seen = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (!bots) return;
    const previous = seen.current;
    seen.current = new Map(bots.map((bot) => [bot.agentId, asksOf(bot)]));
    // The first answer is the state on arrival, not news.
    if (!previous) return;
    if (!notificationsAllowed()) return;
    for (const bot of bots) {
      const now = asksOf(bot);
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
 * One browser notification per ping, never one per item: each time the person's newest ping
 * changes, the notice names what that ping carried. The first answer is the state on arrival, so a
 * page opened after a ping does not announce it again. The tag is the ping's own, so two open tabs
 * show one notice between them.
 *
 * A Bot muted to "Nothing" never reaches a ping (the server leaves its items out), so nothing here
 * filters by Bot.
 */
function usePingNotifications(
  lastPingId: string | null | undefined,
  bots: BotAttention[] | undefined,
) {
  // Read only when a ping arrives: the badge has no other use for the list, so it does not poll it.
  const suggestions = useQuery({
    ...proactiveSuggestionsQueryOptions(),
    enabled: false,
  });
  const seen = useRef<string | null | undefined>(undefined);
  const names = useRef(bots);
  names.current = bots;
  const refetch = suggestions.refetch;
  useEffect(() => {
    if (lastPingId === undefined) return;
    const previous = seen.current;
    seen.current = lastPingId;
    if (previous === undefined || lastPingId === null) return;
    if (lastPingId === previous || !notificationsAllowed()) return;
    void refetch().then(({ data }) => {
      const notice = pingNotice(
        (data ?? []).filter((item) => item.pingId === lastPingId),
        (agentId) =>
          names.current?.find((bot) => bot.agentId === agentId)?.name,
      );
      try {
        new Notification(notice.title, {
          body: notice.body,
          tag: `openbot-ping-${lastPingId}`,
        });
      } catch {
        // A browser that refuses the constructor still has the badge and the list.
      }
    });
  }, [lastPingId, refetch]);
}

/**
 * The badge on the sidebar's Bots item: how many things wait on this person across all their Bots,
 * or a dot when the only news is something unread. Opening Bots lists what is behind the number
 * first, under Needs you.
 *
 * It also sends the browser notifications, since it is the one piece of the app that is always on
 * screen and always reading this.
 *
 * Renders nothing when nothing is waiting, so a quiet day costs the sidebar nothing.
 */
export function BotsNavBadge() {
  const attention = useQuery(botAttentionQueryOptions());
  const lastPing = useQuery(lastPingQueryOptions());
  useAttentionNotifications(attention.data);
  usePingNotifications(lastPing.data, attention.data);
  const bots = attention.data ?? [];
  const waiting = bots.reduce((total, bot) => total + waitingOnYou(bot), 0);
  if (waiting > 0) {
    return (
      <span
        aria-label={`${waiting} ${waiting === 1 ? "thing needs" : "things need"} you`}
        className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums"
        role="img"
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
