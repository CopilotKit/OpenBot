import { Link } from "@tanstack/react-router";
import { memo } from "react";
import type { ExternalThreadSummary } from "@/lib/external/queries";
import { Button } from "../ui/button";
import { ChannelAvatar } from "../channels/avatar";

export const SlackChannel = memo(function SlackChannel({
  lastMessageAt,
  thread,
}: {
  lastMessageAt?: string;
  thread: ExternalThreadSummary;
}) {
  return (
    <Link
      to="/slack/thread/$threadId"
      params={{ threadId: thread.threadId }}
      type="button"
      className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
      activeProps={{
        className: "bg-foreground/5",
      }}
    >
      <SlackChannelContent lastMessageAt={lastMessageAt} thread={thread} />
    </Link>
  );
});

export function SlackChannelContent({
  lastMessageAt,
  thread,
}: {
  lastMessageAt?: string;
  thread: ExternalThreadSummary;
}) {
  return (
    <>
      <div>
        <ChannelAvatar participantIds={[thread.agentId]} size={32} />
      </div>
      <div className="min-w-0 flex-1 flex-col">
        <div className="flex flex-row items-center justify-between gap-2">
          <div
            className="flex min-w-0 flex-1 flex-row items-center gap-1.5"
            data-slot="conversation-title"
          >
            <span className="truncate text-[14px] tracking-[-1%]">
              {thread.agentName}
            </span>
            <span className="shrink-0 rounded border border-border/70 px-1 py-0 text-[10px] leading-4 text-muted-foreground">
              Slack
            </span>
          </div>
          <div className="shrink-0 text-[12px] text-muted-foreground/70">
            {lastMessageAt}
          </div>
        </div>
        <div className="mt-px flex h-4 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
            {thread.lastMessage}
          </span>
        </div>
      </div>
    </>
  );
}

export function SlackRosterProblem({
  isRetrying = false,
  onRetry,
}: {
  isRetrying?: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="px-2 py-2 text-xs text-muted-foreground" role="alert">
      <p>Slack conversations could not be loaded.</p>
      <Button
        className="mt-2 h-7 px-2 text-xs"
        disabled={isRetrying}
        onClick={onRetry}
        size="sm"
        variant="outline"
      >
        {isRetrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
