import { useQuery } from "@tanstack/react-query";
import { ChannelAvatar } from "@/components/channels/avatar";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { ChannelWork } from "@/lib/channels/queries";
import { briefDuration, useNow } from "@/lib/elapsed";
import { useAtWork } from "@/lib/places/at-work";
import { PlaceEmpty, type PlaceEntry, PlaceRow, StripBadge } from "./place-row";

function elapsedSince(since: string, now: number): string {
  return briefDuration((now - Date.parse(since)) / 1000);
}

function AtWorkPlace() {
  const { rows, pending, failed } = useAtWork();
  const now = useNow(1000, rows.length > 0);
  const shown = useQuery(agentListQueryOptions());
  const hidden = useQuery(agentListQueryOptions(true));
  const roster = [...(shown.data ?? []), ...(hidden.data ?? [])];

  const workLine = (work: ChannelWork): string => {
    if (work.kind === "routine") return "Running a routine";
    const name =
      roster.find((bot) => bot.id === work.botId)?.name ??
      work.botName ??
      "a Bot";
    return `Asked ${name}`;
  };

  if (rows.length === 0) {
    if (failed) {
      return (
        <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
          Couldn't load what is running. Try again in a moment.
        </p>
      );
    }
    return pending ? null : (
      <PlaceEmpty>Nothing is running right now.</PlaceEmpty>
    );
  }
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <div key={row.channelId}>
          <PlaceRow
            media={
              <ChannelAvatar participantIds={row.agentIds} size={20} typing />
            }
            title={row.title}
            to={{
              to: row.group ? "/group/$channelId" : "/channel/$channelId",
              params: { channelId: row.channelId },
            }}
            trailing={
              row.since ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {elapsedSince(row.since, now)}
                </span>
              ) : null
            }
          />
          {row.work.map((work) => (
            <p
              className="flex items-center gap-2 truncate pr-2 pl-9 text-muted-foreground text-xs"
              key={work.key}
            >
              <span className="min-w-0 flex-1 truncate">{workLine(work)}</span>
              <span className="shrink-0 tabular-nums">
                {elapsedSince(work.since, now)}
              </span>
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

function AtWorkBadge() {
  const { rows } = useAtWork();
  return rows.length > 0 ? <StripBadge pulse /> : null;
}

export const atWorkPlace: PlaceEntry = {
  List: AtWorkPlace,
  Badge: AtWorkBadge,
};
