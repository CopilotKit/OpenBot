import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { ChannelAvatar } from "../channels/avatar";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
  waiting,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
  /**
   * Whether a Bot in this channel has stopped and is waiting for this person.
   *
   * The trace a missed toast leaves. It sits on the row rather than replacing the preview, because
   * the preview is how somebody recognises which conversation this is, and a row that stops saying
   * what it is about is harder to find, not easier.
   */
  waiting?: boolean;
}) {
  return (
    <Link
      to="/channel/$channelId"
      params={{ channelId }}
      type="button"
      className="flex flex-row py-2 px-2 gap-2 items-center w-full hover:bg-foreground/5 rounded-lg [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
      activeProps={{
        className: "bg-foreground/5",
      }}
    >
      <div className="">
        <ChannelAvatar participantIds={participantIds} size={32} />
      </div>
      <div className="flex-col min-w-0 flex-1">
        <div className="flex flex-row items-center justify-between gap-2">
          <span className="text-[14px] tracking-[-1%] truncate">{name}</span>
          <div className="text-[12px] text-muted-foreground/70">
            {lastMessageAt}
          </div>
        </div>
        <div className="mt-px flex h-4 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
            {lastMessage}
          </span>
          {/* Named for a screen reader, because a coloured dot says nothing to one. */}
          {waiting ? (
            <span
              aria-label="Waiting for you"
              className="size-2 shrink-0 rounded-full bg-amber-500"
              role="status"
            />
          ) : null}
        </div>
      </div>
    </Link>
  );
});
