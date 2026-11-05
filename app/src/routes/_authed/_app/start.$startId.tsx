import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Composer } from "@/components/channels/composer";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { agentQueryOptions } from "@/lib/agents/queries";
import { readPendingStart } from "@/lib/channels/pending-start";

export const Route = createFileRoute("/_authed/_app/start/$startId")({
  component: RouteComponent,
});

/**
 * The conversation a message from home is starting, before it exists.
 *
 * Drawn in the conversation screen's own shape — header, the message at the end of the column, the
 * composer at the bottom — so that being replaced by the real one moves nothing. Everything here is
 * read-only: the composer is disabled because there is no channel yet for anything typed to go to.
 */
function RouteComponent() {
  const { startId } = Route.useParams();
  // Read once: the start forgets itself when it is done, a beat before this screen is replaced, and
  // that must not redirect home in between.
  const [pending] = useState(() => readPendingStart(startId));
  const agent = useQuery({
    ...agentQueryOptions(pending?.agentId ?? ""),
    enabled: Boolean(pending?.agentId),
  });

  // A reload, or a link: nothing is being started under this id, so there is nothing to show.
  if (!pending) return <Navigate replace to="/" />;

  const name = pending.agentId ? (agent.data?.name ?? "") : "Picking a Bot";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        className="min-h-12 border-b border-border sticky top-0 flex flex-row flex-wrap items-center justify-between px-3 py-2 gap-2"
        data-slot="conversation-header"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <SidebarToggle />
          {pending.agentId ? (
            <ChannelAvatar participantIds={[pending.agentId]} size={22} />
          ) : null}
          <span className="min-w-0 text-sm tracking-tight truncate text-muted-foreground">
            {name}
          </span>
        </div>
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 flex flex-col gap-6">
          <Message align="end">
            <MessageContent>
              <Bubble align="end" variant="muted">
                <BubbleContent>
                  {/* Shown exactly as typed, as the conversation will show it. */}
                  <span className="whitespace-pre-wrap">{pending.text}</span>
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
          {/* The same shimmer the conversation shows before a Bot's first word. */}
          <p
            className="tool-line-running text-muted-foreground text-sm"
            role="status"
          >
            Thinking
          </p>
        </div>
      </div>
      <div className="max-w-3xl mx-auto w-full px-0 pb-4 shrink-0">
        <Composer className="relative w-full mt-auto" compact disabled />
      </div>
    </div>
  );
}
