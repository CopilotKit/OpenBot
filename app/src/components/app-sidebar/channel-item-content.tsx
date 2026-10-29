import { IconHandStop, IconPinFilled } from "@tabler/icons-react";
import { ChannelAvatar } from "@/components/channels/avatar";
import type { MessageListEmphasis } from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";

/**
 * Shared by live conversations and the appearance preference previews.
 *
 * The second line says the one thing most worth knowing. A conversation that waits on you says so,
 * in orange, which means nothing else in OpenBot. One whose Bot is working shows the working dots
 * in place of its summary, so the avatar carries no badge of its own. Otherwise it is the summary.
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
  waiting = false,
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
  /** An approval or a question in this conversation waits on the person. */
  waiting?: boolean;
}) {
  const primaryText = `text-[0.9rem] leading-5 tracking-[-1%] ${unread ? "font-semibold" : "font-medium"}`;
  const secondaryText = "text-[12px] leading-4 text-muted-foreground";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="shrink-0">
        <ChannelAvatar participantIds={participantIds} size={32} />
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
        {waiting ? (
          <div className="mt-px flex items-center gap-1 text-[12px] font-medium leading-4 text-[#9a5200] dark:text-[#ffc27a]">
            <IconHandStop aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">Waiting for you</span>
          </div>
        ) : busy ? (
          <div className="mt-px flex h-4 items-center gap-1">
            <span className="sr-only">Working…</span>
            <WorkingDot />
            <WorkingDot className="[animation-delay:150ms]" />
            <WorkingDot className="[animation-delay:300ms]" />
          </div>
        ) : (
          <div
            className={`mt-px truncate ${emphasis === "thread" ? primaryText : secondaryText}`}
            title={title}
          >
            {displayedTitle}
            {revealing ? (
              <span className="ml-0.5 inline-block h-3 w-px translate-y-px bg-foreground/70 align-middle" />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkingDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 rounded-[2px] bg-muted-foreground animate-pulse motion-reduce:animate-none",
        className,
      )}
    />
  );
}
