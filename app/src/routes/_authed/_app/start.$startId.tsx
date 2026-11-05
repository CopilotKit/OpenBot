import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import type { Message } from "@ag-ui/core";
import { useLayoutEffect, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  ConversationIntro,
  ConversationIntroPlaceholder,
} from "@/components/channels/conversation-intro";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { agentListQueryOptions, agentQueryOptions } from "@/lib/agents/queries";
import {
  readPendingStart,
  startedChannelFor,
} from "@/lib/channels/pending-start";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/_app/start/$startId")({
  component: RouteComponent,
});

/**
 * The conversation a message from home is starting, before it exists.
 *
 * Drawn with the conversation screen's own parts, not a copy of them: its header, and the same
 * `ConversationView` the real one renders, holding the message as its first turn, busy, so the
 * "Thinking" line, the notification offer and the composer are the real ones in the real places,
 * with the Bot's intro above the message (or its footprint, while a Bot is still being picked). A
 * hand-drawn copy put the message 48px higher than the conversation lands it, without the intro
 * above it or the scrollbar's gutter beside it, so the message jumped down and sideways the moment
 * the conversation replaced it. Everything here is read-only: the composer is disabled
 * because there is no channel yet for anything typed to go to.
 */
function RouteComponent() {
  const { startId } = Route.useParams();
  // Read once: the start forgets itself when it is done, a beat before this screen is replaced, and
  // that must not redirect home in between. The message is made once too, so it keeps its identity.
  const [pending] = useState(() => readPendingStart(startId));
  const [seed] = useState(() =>
    pending ? seedMessage(pending.text, `pending-${startId}`) : null,
  );
  /*
   * The Bot an `@` named, from the roster the home page already loaded, so its name, avatar and
   * intro are on the first frame rather than after a request. A Bot the roster hides (reached by
   * name, not listed) is fetched on its own.
   */
  const agentId = pending?.agentId ?? null;
  const roster = useQuery(agentListQueryOptions());
  const listed = agentId
    ? roster.data?.find((agent) => agent.id === agentId)
    : undefined;
  const fetched = useQuery({
    ...agentQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId) && roster.data !== undefined && !listed,
  });
  const bot = listed ?? fetched.data;
  /*
   * The message goes in one commit after the intro, not with it. The conversation that replaces
   * this lands its first message the same way: its seed is swapped for the thread's own copy, a new
   * row, and the scroller pins a newly arrived message of the person's near the top, with the end of
   * the intro showing above it. Drawn in the first commit, the message is not "arrived" but simply
   * there, and sits under the whole intro, a hand's width lower than the conversation puts it. A
   * layout effect, so both commits land before the first paint.
   */
  const [shown, setShown] = useState<readonly Message[]>([]);
  useLayoutEffect(() => {
    if (seed) setShown([seed]);
  }, [seed]);

  // Back to a placeholder whose conversation now exists: that conversation is what they came for.
  const [started] = useState(() => startedChannelFor(startId));
  if (started)
    return (
      <Navigate
        params={{ channelId: started }}
        replace
        to="/channel/$channelId"
      />
    );
  // A reload, or a link: nothing is being started under this id, so there is nothing to show.
  if (!pending || !seed) return <Navigate replace to="/" />;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="min-h-12 border-b border-border sticky top-0 flex flex-row flex-wrap items-center justify-between px-3 py-2 gap-2"
        data-slot="conversation-header"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <SidebarToggle />
          {agentId ? (
            <ChannelAvatar participantIds={[agentId]} size={22} />
          ) : null}
          <span
            className={cn(
              "min-w-0 text-sm tracking-tight truncate",
              agentId ? null : "text-muted-foreground",
            )}
          >
            {agentId ? (bot?.name ?? "") : "Picking a Bot"}
          </span>
        </div>
      </div>
      <ConversationView
        busy
        disabled
        intro={
          // The Bot's own intro when an `@` named it, and its footprint while one is being picked:
          // the conversation that replaces this has an intro above the message either way.
          bot ? (
            <ConversationIntro agent={bot} />
          ) : (
            <ConversationIntroPlaceholder />
          )
        }
        messages={shown}
        onSubmit={() => undefined}
      />
    </div>
  );
}
