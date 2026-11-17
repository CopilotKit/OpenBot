import { PreviewCard } from "@base-ui/react/preview-card";
import { type ReactNode, useState } from "react";
import { useBotNames } from "@/lib/agents/bot-names";
import { untitledLine } from "@/lib/channels/label";
import type { ChannelSummary } from "@/lib/channels/queries";
import { relativeTime } from "@/lib/relative-time";

/** Whether the only way to point is a finger, where a hover card would never be seen. */
function isTouchOnly(): boolean {
  try {
    return (
      window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ??
      false
    );
  } catch {
    return false;
  }
}

/**
 * What a conversation holds, drawn beside its row after a short hover or on keyboard focus: its
 * title, its last message, its Bots and when it last moved.
 *
 * The row keeps its own link and context menu; this only wraps it. Base UI opens the card on focus
 * as well as hover, so the keyboard sees the same thing. A touch-only device has no hover, so it is
 * given the row alone.
 */
export function ConversationCard({
  channel,
  children,
}: {
  channel: ChannelSummary;
  children: ReactNode;
}) {
  const botName = useBotNames();
  const [touchOnly] = useState(isTouchOnly);
  if (touchOnly) return children;

  const title = channel.summary || untitledLine(channel) || "New conversation";
  const bots = channel.agentIds.map(botName).join(", ");

  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={<div />}>{children}</PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side="right"
          align="start"
          sideOffset={8}
          className="isolate z-50"
        >
          <PreviewCard.Popup className="flex w-64 flex-col gap-1.5 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md outline-hidden">
            <p className="font-medium">{title}</p>
            {channel.lastMessage ? (
              <p className="line-clamp-3 text-muted-foreground">
                {channel.lastMessage}
              </p>
            ) : null}
            {bots ? (
              <p className="text-xs text-muted-foreground">{bots}</p>
            ) : null}
            {channel.lastMessageAt ? (
              <p className="text-xs text-muted-foreground">
                {relativeTime(channel.lastMessageAt)}
              </p>
            ) : null}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
