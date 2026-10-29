import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  approvalInboxCacheOptions,
  approvalInboxOptions,
} from "@/lib/approvals";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { queryClient } from "@/query-client";
import { type ConversationFacts, needsYouCount, taskItem } from "./groups";
import {
  type TaskRecord,
  type TaskStatus,
  taskKeys,
  taskListQueryOptions,
  taskQueryOptions,
} from "./queries";

/** What the conversation list says about one conversation, as Tasks reads it. */
export function conversationFacts(
  channel: ChannelSummary | undefined,
): ConversationFacts | undefined {
  if (!channel) return undefined;
  return {
    // The sidebar's rule: a turn running, or work the conversation waits on between turns.
    busy: (channel.busy ?? false) || (channel.work?.length ?? 0) > 0,
    lastMessageAt: channel.lastMessageAt,
  };
}

/**
 * Whether a turn is running in this conversation now, as the conversation list's working dot says.
 *
 * When the dot comes on or goes out, the tasks are read again at once: a turn started or ended, so
 * where the task stands has changed, and the quiet poll would leave the old status up for half a
 * minute.
 */
export function useConversationBusy(channelId: string | undefined): boolean {
  const roster = useInfiniteQuery(channelListQueryOptions());
  const row = channelId
    ? roster.data?.find((channel) => channel.id === channelId)
    : undefined;
  const busy = conversationFacts(row)?.busy ?? false;
  const was = useRef(busy);
  useEffect(() => {
    if (was.current !== busy)
      void queryClient.invalidateQueries({ queryKey: taskKeys.all });
    was.current = busy;
  }, [busy]);
  return busy;
}

/**
 * One task and where it stands right now, for its card in a conversation. Read from the list every
 * card shares, so a thread of cards is one request; a task too old to be on the list is read alone.
 */
export function useTask(taskId: string): {
  task: TaskRecord | undefined;
  status: TaskStatus | null;
} {
  const list = useQuery(taskListQueryOptions());
  const listed = list.data?.find((task) => task.id === taskId);
  const alone = useQuery({
    ...taskQueryOptions(taskId),
    enabled: !list.isPending && !listed,
  });
  const task = listed ?? alone.data;
  const roster = useInfiniteQuery(channelListQueryOptions());
  // One card per call, so it reads the inbox the conversation polls and keeps no poll of its own.
  const inbox = useQuery(approvalInboxCacheOptions());
  // Kept so the dot coming on or going out reads the task again.
  useConversationBusy(task?.channelId);
  if (!task) return { task, status: null };
  const row = roster.data?.find((channel) => channel.id === task.channelId);
  return {
    task,
    status: taskItem(task, conversationFacts(row), inbox.data).status,
  };
}

/** How many tasks wait on the person, for the sidebar's Tasks entry and a skin's Tasks tab. */
export function useNeedsYouCount(): number {
  const tasks = useQuery(taskListQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  return needsYouCount(tasks.data, inbox.data);
}
