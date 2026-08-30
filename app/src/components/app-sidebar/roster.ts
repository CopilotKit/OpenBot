import { linkOptions, type LinkOptions } from "@tanstack/react-router";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { ExternalThreadSummary } from "@/lib/external/queries";

export type SidebarRosterRow =
  | { kind: "openbot"; channel: ChannelSummary }
  | { kind: "slack"; thread: ExternalThreadSummary };

export type RosterSourceStatus = "pending" | "success" | "error";

const openbotChannelRoute = "/channel/$channelId" as const;
const slackThreadRoute = "/slack/thread/$threadId" as const;

export function rosterKey(row: SidebarRosterRow): string {
  return row.kind === "openbot"
    ? `openbot:${row.channel.id}`
    : `slack:${row.thread.threadId}`;
}

function activityAt(row: SidebarRosterRow): string {
  const source = row.kind === "openbot" ? row.channel : row.thread;
  return source.lastMessageAt ?? source.createdAt;
}

export function conversationRoster(
  channels: ChannelSummary[] = [],
  slackThreads: ExternalThreadSummary[] = [],
): SidebarRosterRow[] {
  const nativeRows = channels.map(
    (channel): SidebarRosterRow & { kind: "openbot" } => ({
      kind: "openbot",
      channel,
    }),
  );
  const slackRows = slackThreads.map(
    (thread): SidebarRosterRow & { kind: "slack" } => ({
      kind: "slack",
      thread,
    }),
  );
  const pinned = nativeRows.filter(
    (row) => row.kind === "openbot" && row.channel.pinned,
  );
  const remaining = [
    ...nativeRows.filter((row) => !row.channel.pinned),
    ...slackRows,
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
        to: slackThreadRoute,
        params: { threadId: row.thread.threadId },
      });
}

export function shouldShowEmptyRoster(
  channels: readonly ChannelSummary[] | undefined,
  slackThreads: readonly ExternalThreadSummary[] | undefined,
  channelsLoaded: boolean,
  slackThreadsLoaded: boolean,
): boolean {
  return (
    channelsLoaded &&
    slackThreadsLoaded &&
    channels?.length === 0 &&
    slackThreads?.length === 0
  );
}

export function shouldShowSearchEmpty(
  visibleRows: readonly SidebarRosterRow[],
  query: string,
  channelsStatus: RosterSourceStatus,
  slackThreadsStatus: RosterSourceStatus,
): boolean {
  return (
    query.trim().length > 0 &&
    channelsStatus === "success" &&
    slackThreadsStatus === "success" &&
    visibleRows.length === 0
  );
}
