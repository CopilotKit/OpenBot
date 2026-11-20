import { IconPinFilled } from "@tabler/icons-react";
import { ChannelAvatar } from "@/components/channels/avatar";
import type { ConversationView } from "@/lib/settings/conversation-view";
import type { MessageListEmphasis } from "@/lib/settings/message-list";

/**
 * Shared by live conversations and the appearance preference previews.
 *
 * `view` picks the row's shape. Detailed (the default here) is two lines: the Bot's name, its time
 * and marks, then the title. Compact is one line, as Claude's sidebar lists chats: a small avatar
 * and the title, then the time, the unread dot and the pin at the right. It draws no Bot name, and
 * says it to a screen reader.
 */
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
  view = "detailed",
  avatar = true,
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
  view?: ConversationView;
  /** False where the row sits under its Bot already (the Bots panel), so the orb is not said twice. */
  avatar?: boolean;
}) {
  const unreadDot = unread ? (
    <span
      className="size-2 shrink-0 rounded-full bg-primary"
      data-slot="unread-dot"
    />
  ) : null;
  const pin = pinned ? (
    <IconPinFilled
      className="size-3 shrink-0 text-muted-foreground/70"
      data-slot="pinned"
    />
  ) : null;
  /*
   * While a Bot works on it, the row says so where its time goes, in the one colour that means a Bot
   * is acting right now: said as well as shown by the orb, and the time is news only once the work
   * is done.
   */
  const time = busy ? (
    <span className="shrink-0 whitespace-nowrap font-medium text-[12px] text-indigo-600 leading-4 dark:text-indigo-300">
      Working
    </span>
  ) : (
    <span className="shrink-0 whitespace-nowrap text-[12px] leading-4 text-muted-foreground/70">
      {lastMessageAt}
    </span>
  );
  const caret = revealing ? (
    <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-foreground/70 align-middle" />
  ) : null;

  if (view === "compact") {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {avatar ? (
          <div className="shrink-0">
            <ChannelAvatar
              participantIds={participantIds}
              size={20}
              typing={busy}
            />
          </div>
        ) : null}
        {/*
         * Not drawn, but read out: the orb is hidden from a screen reader, so without this every row
         * is a title and a time with no Bot. Under its Bot (no avatar) the Bot is said already.
         */}
        {avatar ? (
          <span className="sr-only" data-slot="bot-name">{`${name}, `}</span>
        ) : null}
        <span
          className={`min-w-0 flex-1 truncate text-sm leading-5 tracking-[-1%] ${unread ? "font-semibold" : "font-normal"}`}
          title={title}
        >
          {displayedTitle}
          {caret}
        </span>
        {time}
        {unreadDot}
        {pin}
      </div>
    );
  }

  const primaryText = `text-sm leading-5 tracking-[-1%] ${unread ? "font-semibold" : "font-medium"}`;
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
          {time}
          {unreadDot}
          {pin}
        </div>
        <div
          className={`mt-px truncate ${emphasis === "thread" ? primaryText : secondaryText}`}
          title={title}
        >
          {displayedTitle}
          {caret}
        </div>
      </div>
    </div>
  );
}
