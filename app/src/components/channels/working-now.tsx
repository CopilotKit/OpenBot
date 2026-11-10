import { Link } from "@tanstack/react-router";
import { ChannelAvatar } from "@/components/channels/avatar";
import { untitledLine } from "@/lib/channels/label";
import type { ChannelSummary } from "@/lib/channels/queries";

/**
 * WHAT A BOT IS DOING RIGHT NOW, said on the home page: a note at the foot of the page while a turn runs in one of the
 * person's conversations, with the way to it. Starting something new is what home is for, and this is the one thing
 * worth knowing before that: a Bot is already working. One note, for the conversation that changed last; the sidebar
 * marks every one that is working.
 *
 * Floats over the page on a solid surface, as a popover does, and it is drawn
 * only while something works, so an idle home is the greeting and the composer and nothing else.
 */
export function WorkingNow({
  channels,
}: {
  channels: ChannelSummary[] | undefined;
}) {
  const working = channels?.find((channel) => channel.busy);
  if (!working) return null;
  const title = working.summary || untitledLine(working) || "New conversation";
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center px-4">
      <Link
        className="pointer-events-auto flex max-w-xl min-w-0 items-center gap-3 rounded-full border bg-popover py-2 pr-2 pl-2.5 text-popover-foreground shadow-lg transition-colors hover:bg-muted"
        params={{ channelId: working.id }}
        to={
          working.agentIds.length > 1
            ? "/group/$channelId"
            : "/channel/$channelId"
        }
      >
        <ChannelAvatar participantIds={working.agentIds} size={28} typing />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-medium text-sm">
            {working.name} is working
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {title}
          </span>
        </span>
        <span className="shrink-0 rounded-full border bg-background px-3 py-1 font-medium text-xs">
          Open
        </span>
      </Link>
    </div>
  );
}
