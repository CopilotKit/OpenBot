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
  dense = false,
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
  /** One line for the sidebar roster: a small avatar and one title, no time, no pin icon. */
  dense?: boolean;
}) {
  const primaryText = `text-sm leading-5 tracking-[-1%] ${unread ? "font-semibold" : "font-medium"}`;
  const secondaryText = "text-[12px] leading-4 text-muted-foreground";

  if (dense) {
    const denseTitle = emphasis === "agent" ? name : displayedTitle;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="shrink-0">
          <ChannelAvatar
            participantIds={participantIds}
            size={20}
            typing={busy}
          />
        </div>
        <span
          className={`min-w-0 flex-1 truncate ${primaryText}`}
          title={emphasis === "agent" ? name : title}
        >
          {denseTitle}
          {emphasis === "thread" && revealing ? (
            <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-foreground/70 align-middle" />
          ) : null}
        </span>
        {unread ? (
          <span className="size-2 shrink-0 rounded-full bg-primary" />
        ) : busy ? (
          <span
            aria-label="Working"
            className="size-1.5 shrink-0 rounded-full bg-indigo-600 dark:bg-indigo-300"
            role="img"
          />
        ) : null}
      </div>
    );
  }

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
          {/*
           * While a Bot works on it, the row says so where its time goes, in the one colour that means a Bot is acting
           * right now: said as well as shown by the orb, and the time is news only once the work is done.
           */}
          {busy ? (
            <span className="shrink-0 whitespace-nowrap font-medium text-[12px] text-indigo-600 leading-4 dark:text-indigo-300">
              Working
            </span>
          ) : (
            <span className="shrink-0 whitespace-nowrap text-[12px] leading-4 text-muted-foreground/70">
              {lastMessageAt}
            </span>
          )}
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
