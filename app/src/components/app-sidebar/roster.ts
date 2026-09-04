import { linkOptions, type LinkOptions } from "@tanstack/react-router";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { ExternalThreadSummary } from "@/lib/external/queries";

export type SidebarRosterRow =
  | { kind: "openbot"; channel: ChannelSummary }
  | { kind: "external"; thread: ExternalThreadSummary };

export type RosterSourceStatus = "pending" | "success" | "error";

const openbotChannelRoute = "/channel/$channelId" as const;
const externalThreadRoute = "/external/$provider/thread/$threadId" as const;

export function rosterKey(row: SidebarRosterRow): string {
  return row.kind === "openbot"
    ? `openbot:${row.channel.id}`
    : `external:${row.thread.provider}:${row.thread.threadId}`;
}

function activityAt(row: SidebarRosterRow): string {
  const source = row.kind === "openbot" ? row.channel : row.thread;
  return source.lastMessageAt ?? source.createdAt;
}

export function conversationRoster(
  channels: ChannelSummary[] = [],
  externalThreads: ExternalThreadSummary[] = [],
): SidebarRosterRow[] {
  const nativeRows = channels.map(
    (channel): SidebarRosterRow & { kind: "openbot" } => ({
      kind: "openbot",
      channel,
    }),
  );
  const externalRows = externalThreads.map(
    (thread): SidebarRosterRow & { kind: "external" } => ({
      kind: "external",
      thread,
    }),
  );
  const pinned = nativeRows.filter(
    (row) => row.kind === "openbot" && row.channel.pinned,
  );
  const remaining = [
    ...nativeRows.filter((row) => !row.channel.pinned),
    ...externalRows,
  ];

  return [
    ...pinned.sort(byActivityThenKey),
    ...remaining.sort(byActivityThenKey),
  ];
}

function byActivityThenKey(a: SidebarRosterRow, b: SidebarRosterRow): number {
  const activity = activityAt(b).localeCompare(activityAt(a));
  if (activity !== 0) return activity;
  return rosterKey(a).localeCompare(rosterKey(b));
}

export function matchingRoster(
  rows: SidebarRosterRow[] | undefined,
  query: string,
): SidebarRosterRow[] {
  if (!rows) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) =>
    [rosterName(row), rosterLastMessage(row)].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

export function rosterName(row: SidebarRosterRow): string {
  return row.kind === "openbot" ? row.channel.name : row.thread.agentName;
}

export function rosterLastMessage(row: SidebarRosterRow): string | null {
  return row.kind === "openbot"
    ? row.channel.lastMessage
    : row.thread.lastMessage;
}

export function rosterDestination(row: SidebarRosterRow): LinkOptions {
  return row.kind === "openbot"
    ? linkOptions({
        to: openbotChannelRoute,
        params: { channelId: row.channel.id },
      })
    : linkOptions({
        to: externalThreadRoute,
        params: {
          provider: row.thread.provider,
          threadId: row.thread.threadId,
        },
      });
}

export function shouldShowEmptyRoster(
  channels: readonly ChannelSummary[] | undefined,
  externalThreads: readonly ExternalThreadSummary[] | undefined,
  channelsLoaded: boolean,
  externalThreadsLoaded: boolean,
): boolean {
  return (
    channelsLoaded &&
    externalThreadsLoaded &&
    channels?.length === 0 &&
    externalThreads?.length === 0
  );
}

export function shouldShowSearchEmpty(
  visibleRows: readonly SidebarRosterRow[],
  query: string,
  channelsStatus: RosterSourceStatus,
  externalThreadsStatus: RosterSourceStatus,
): boolean {
  return (
    query.trim().length > 0 &&
    channelsStatus === "success" &&
    externalThreadsStatus === "success" &&
    visibleRows.length === 0
  );
}
