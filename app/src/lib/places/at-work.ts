import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  type ChannelWork,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { type ListedTask, orderTasks } from "@/lib/tasks/groups";
import { taskListQueryOptions } from "@/lib/tasks/queries";

/** One conversation with something running or owed in it. */
export type AtWorkRow = {
  /** The conversation the work is in. One row per conversation. */
  channelId: string;
  /** More than one Bot: it opens as a group conversation. */
  group: boolean;
  agentIds: string[];
  /** Its summary, else its opening line, else "New conversation". */
  title: string;
  /** What is owed in it, oldest first. */
  work: ChannelWork[];
  /** When the oldest of that work began, or null when none is timed. */
  since: string | null;
};

function rowOfChannel(channel: ChannelSummary): AtWorkRow {
  const work = [...(channel.work ?? [])].sort((a, b) =>
    a.since < b.since ? -1 : a.since > b.since ? 1 : 0,
  );
  return {
    channelId: channel.id,
    group: channel.agentIds.length > 1,
    agentIds: channel.agentIds,
    title: channel.summary || untitledLine(channel) || "New conversation",
    work,
    since: work[0]?.since ?? null,
  };
}

/**
 * Everything running on its own right now, one row per conversation: a conversation owed work by
 * another Bot or a routine, then each working task whose conversation is not already there. A Bot
 * answering the message the person just sent is not listed: that reply shows in its conversation.
 * Rows with a start time come first, the longest-running at the top; the rest keep the order the
 * list gave them.
 */
export function atWork(
  channels: readonly ChannelSummary[],
  tasks: readonly ListedTask[],
): AtWorkRow[] {
  const rows = channels
    .filter((channel) => (channel.work?.length ?? 0) > 0)
    .map(rowOfChannel);
  const seen = new Set(rows.map((row) => row.channelId));
  for (const { task, status } of tasks) {
    if (status !== "working" || seen.has(task.channelId)) continue;
    seen.add(task.channelId);
    const listedChannel = channels.find(
      (channel) => channel.id === task.channelId,
    );
    rows.push(
      listedChannel
        ? rowOfChannel(listedChannel)
        : {
            channelId: task.channelId,
            group: false,
            agentIds: [task.agentId],
            title: task.title,
            work: [],
            since: null,
          },
    );
  }
  const timed = rows
    .filter((row) => row.since !== null)
    .sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  return [...timed, ...rows.filter((row) => row.since === null)];
}

/**
 * What is running on its own, live: the conversation list and the task list. A task counts as the
 * server says, not upgraded to Working by a reply running in its conversation, for the same reason.
 */
export function useAtWork(): {
  rows: AtWorkRow[];
  pending: boolean;
  /** Whether either read failed, so an empty list is not a promise that nothing is running. */
  failed: boolean;
} {
  const channels = useInfiniteQuery(channelListQueryOptions());
  const taskList = useQuery(taskListQueryOptions());
  const tasks = orderTasks(taskList.data ?? [], () => false, Date.now());
  return {
    rows: atWork(channels.data ?? [], tasks),
    pending: channels.isPending || taskList.isPending,
    failed: channels.isError || taskList.isError,
  };
}
