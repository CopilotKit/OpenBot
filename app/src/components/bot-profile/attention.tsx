import { IconPlayerPause } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type BotAttention,
  botAttentionQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

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
 * The Bots that need this person, for the sidebar: a badge per Bot that has a question, an approval
 * or a stalled hand-off waiting, or something unread, and a resume button for one they paused.
 *
 * Renders nothing when no Bot needs anything, so a quiet day costs the roster no space.
 */
export function BotAttentionList() {
  const attention = useQuery(botAttentionQueryOptions());
  const resume = useMutation(setBotPausedMutationOptions(queryClient));
  useAttentionNotifications(attention.data);
  const bots = (attention.data ?? []).filter(
    (bot) => bot.paused || needsInput(bot) > 0 || bot.unread > 0,
  );
  if (attention.isPending || attention.error || bots.length === 0) return null;
  return (
    <>
      {bots.map((bot) => {
        const waiting = needsInput(bot);
        return (
          <SidebarMenuItem key={bot.agentId} className="flex flex-row gap-1">
            <SidebarMenuButton
              aria-label={`${bot.name}: ${bot.paused ? "paused" : attentionSummary(bot)}`}
              className="hover:bg-foreground/5 h-9 flex-1"
              render={(props) => (
                <Link
                  {...props}
                  to="/bots/$agentId"
                  params={{ agentId: bot.agentId }}
                  activeProps={{ className: "bg-foreground/5" }}
                />
              )}
            >
              <span className="truncate text-sm">{bot.name}</span>
              {waiting > 0 ? (
                <span
                  className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums"
                  title={attentionSummary(bot)}
                >
                  {waiting}
                </span>
              ) : bot.unread > 0 ? (
                <span
                  className="ml-auto size-2 rounded-full bg-primary"
                  title={attentionSummary(bot)}
                />
              ) : null}
            </SidebarMenuButton>
            {bot.paused ? (
              <SidebarMenuButton
                className="hover:bg-foreground/5 h-9 w-auto shrink-0 gap-1 text-muted-foreground text-xs"
                disabled={resume.isPending}
                onClick={() =>
                  resume.mutate({ agentId: bot.agentId, paused: false })
                }
              >
                <IconPlayerPause className="size-3.5" />
                Paused, tap to resume
              </SidebarMenuButton>
            ) : null}
          </SidebarMenuItem>
        );
      })}
    </>
  );
}
