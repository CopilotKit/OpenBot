import { IconPinFilled } from "@tabler/icons-react";
import { ChannelAvatar } from "@/components/channels/avatar";
import type { MessageListEmphasis } from "@/lib/settings/message-list";

/** Shared by live conversations and the appearance preference previews. */
export function ChannelItemContent({
  participantIds,
  name,
  title,
  displayedTitle = title,
  lastMessageAt,
  emphasis,
  busy = false,
  unread = false,
  pinned = false,
  revealing = false,
}: {
  participantIds: string[];
  name: string;
  title: string;
  displayedTitle?: string;
  lastMessageAt?: string;
  emphasis: MessageListEmphasis;
  busy?: boolean;
  unread?: boolean;
  pinned?: boolean;
  revealing?: boolean;
}) {
  const primaryText = `text-[0.9rem] leading-5 tracking-[-1%] ${unread ? "font-semibold" : "font-medium"}`;
  const secondaryText = "text-[12px] leading-4 text-muted-foreground";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="shrink-0">
        <ChannelAvatar
          participantIds={participantIds}
          size={32}
          typing={busy}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate ${emphasis === "agent" ? primaryText : secondaryText}`}
            title={name}
          >
            {name}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[12px] leading-4 text-muted-foreground/70">
            {lastMessageAt}
          </span>
          {unread ? (
            <span className="size-2 shrink-0 rounded-full bg-primary" />
          ) : null}
          {pinned ? (
            <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
          ) : null}
        </div>
        <div
          className={`mt-px truncate ${emphasis === "thread" ? primaryText : secondaryText}`}
          title={title}
        >
          {displayedTitle}
          {revealing ? (
            <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-foreground/70 align-middle" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
