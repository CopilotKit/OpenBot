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
  // On the type scale: the line that leads at the sub size, the other a caption.
  const primaryText = `type-sub ${unread ? "font-semibold" : "font-medium"}`;
  const secondaryText = "type-caption text-muted-foreground";

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
           * The sidebar row's "…" button sits over this end of the line while it shows: under the
           * pointer, with focus in the row, or with its menu open. The time and marks step aside
           * for it. Under 768px the button always shows and the row keeps room for it instead. The
           * preview in Settings is in no menu item, so none of this reaches it.
           */}
          <span className="flex shrink-0 items-center gap-1.5 md:group-has-[[data-sidebar=menu-action][aria-expanded=true]]/menu-item:opacity-0 md:group-focus-within/menu-item:opacity-0 md:group-hover/menu-item:opacity-0">
            <span className="type-caption whitespace-nowrap text-muted-foreground">
              {lastMessageAt}
            </span>
            {unread ? (
              <span className="size-2 shrink-0 rounded-full bg-brand" />
            ) : null}
            {pinned ? (
              <IconPinFilled className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
          </span>
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
