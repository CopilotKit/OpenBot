import { IconChevronLeft } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  ConversationOrb,
  ConversationPresenceProvider,
} from "@/components/channels/conversation-presence";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";
import { taskItem } from "@/lib/tasks/groups";
import {
  replyToTaskMutationOptions,
  resolveTaskMutationOptions,
  tryTaskAgainMutationOptions,
} from "@/lib/tasks/mutations";
import {
  type TaskRecord,
  taskKeys,
  taskQueryOptions,
  taskReportQueryOptions,
} from "@/lib/tasks/queries";
import { useConversationBusy } from "@/lib/tasks/use-task";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { beganLine, TaskReportView } from "./task-report";
import { STATUS_TONE, TaskStatusWord } from "./task-status";

/** The orb in a task's header, the size a conversation's header draws it. */
const HEADER_ORB_SIZE = 32;

/** Try again lost to a run already going: the server took the task back up itself. */
const ALREADY_RUNNING =
  /already being tried again|couldn't finish can be tried/i;

/**
 * One task, open: its title and where it stands, with Mark done (or Reopen) and, when it couldn't
 * finish, Try again. Under that, how it began and its report, then the task's own conversation,
 * drawn with the same transcript and approval cards as any other. Replying steers the task: the
 * reply goes to the server, which runs it after whatever the task is doing.
 *
 * A task that couldn't finish takes a reply as Try again, with the person's words beside the ask,
 * so a reply never runs without the task it belongs to.
 */
export function TaskPage({ taskId }: { taskId: string }) {
  const task = useQuery(taskQueryOptions(taskId));
  if (task.isPending) return null;
  // A refresh that fails keeps the task it already has, and its conversation with what was typed.
  if (!task.data)
    return (
      <div className="flex flex-col">
        <TaskHeaderBar />
        <p className="p-8 text-destructive text-sm" role="alert">
          Couldn't open this task. Go back to Tasks and try again.
        </p>
      </div>
    );
  return (
    <ConversationPresenceProvider
      channelId={task.data.channelId}
      threadId={task.data.threadId ?? undefined}
    >
      <TaskBody stale={task.isRefetchError} task={task.data} />
    </ConversationPresenceProvider>
  );
}

/** Back to the list, on a screen too narrow to show it beside the task. */
function BackToTasks() {
  return (
    <Button
      aria-label="Back to Tasks"
      className="text-muted-foreground @4xl:hidden"
      render={<Link to="/tasks" />}
      size="icon"
      variant="ghost"
    >
      <IconChevronLeft className="size-4.5" />
    </Button>
  );
}

/** The header's left end: Back on a narrow screen, the sidebar's toggle wherever it is hidden. */
function TaskHeaderBar() {
  return (
    <div className="flex min-h-12 items-center gap-1.5 border-border border-b px-3 py-2">
      <BackToTasks />
      <SidebarToggle className="@4xl:hidden" />
    </div>
  );
}

function TaskBody({
  task,
  stale,
}: {
  task: TaskRecord;
  /** The last read of the task failed, so what is shown is from the one before. */
  stale: boolean;
}) {
  // Open on screen is read, as a conversation's own page is.
  useMarkOpenChannelRead(task.channelId);
  const busy = useConversationBusy(task.channelId);
  const inbox = useQuery(approvalInboxOptions());
  const bots = useQuery(agentListQueryOptions());
  const conversation = useQuery(channelQueryOptions(task.channelId));
  const { status, next } = taskItem(
    task,
    { busy, lastMessageAt: null },
    inbox.data,
  );
  const report = useQuery(taskReportQueryOptions(task.id, status));
  const resolve = useMutation(resolveTaskMutationOptions(queryClient));
  const again = useMutation(tryTaskAgainMutationOptions(queryClient));
  const reply = useMutation(replyToTaskMutationOptions(queryClient));
  const botName =
    bots.data?.find((bot) => bot.id === task.botId)?.name ?? "your Bot";
  const done = task.resolvedAt !== null;
  const failed = status === "failed";
  /*
   * A turn runs in the task's conversation, or is about to: its own on the server, a reply waiting
   * its turn, or Try again on its way.
   */
  const serverTurn = task.status === "working" || again.isPending || busy;
  /*
   * While the task carries a failure (failed, or marked done after failing) a reply runs it again:
   * the person's words as their own message, with the ask beside them.
   */
  const replyRunsTask = task.failure !== null && !serverTurn;
  const error = resolve.error ?? again.error ?? reply.error;
  const clearErrors = () => {
    // A new action owns the notice; pending ones keep their busy state.
    for (const mutation of [resolve, again, reply])
      if (mutation.error) mutation.reset();
  };

  // A turn in the conversation just ended: what it said and did belongs in the report now.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy)
      void queryClient.invalidateQueries({
        queryKey: taskKeys.report(task.id),
      });
    wasBusy.current = busy;
  }, [busy, task.id]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-border border-b px-3 py-2"
        data-slot="task-header"
      >
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-1.5">
          <BackToTasks />
          <SidebarToggle className="@4xl:hidden" />
          <span className="shrink-0">
            <ConversationOrb
              participantIds={[task.botId]}
              size={HEADER_ORB_SIZE}
            />
          </span>
          <div className="flex min-w-0 flex-col pl-1">
            <h1 className="type-sub truncate font-medium">{task.title}</h1>
            <p
              aria-live="polite"
              className="type-caption truncate text-muted-foreground"
            >
              <TaskStatusWord status={status} />
              {" · "}
              <span
                className={cn(
                  (status === "needs_input" || status === "failed") &&
                    STATUS_TONE[status],
                )}
              >
                {next}
              </span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {failed ? (
            <Button
              disabled={again.isPending}
              onClick={() => {
                clearErrors();
                again.mutate({ id: task.id });
              }}
              size="sm"
            >
              {again.isPending ? "Trying again…" : "Try again"}
            </Button>
          ) : null}
          <Button
            disabled={resolve.isPending}
            onClick={() => {
              clearErrors();
              resolve.mutate({ id: task.id, done: !done });
            }}
            size="sm"
            variant={status === "ready_for_review" ? "default" : "outline"}
          >
            {done ? "Reopen" : "Mark done"}
          </Button>
        </div>
      </div>
      {error ? (
        <p
          className="shrink-0 border-border border-b px-4 py-2 text-destructive text-sm"
          role="alert"
        >
          {error.message}
        </p>
      ) : null}
      {stale ? (
        <p
          className="shrink-0 border-border border-b px-4 py-2 text-muted-foreground text-sm"
          role="status"
        >
          Couldn't refresh this task. Reload the page.
        </p>
      ) : null}
      <div
        className="max-h-[40%] shrink-0 overflow-y-auto border-border border-b"
        data-slot="task-report"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-3">
          <p className="type-caption text-muted-foreground">
            {beganLine(task)}
          </p>
          {replyRunsTask ? (
            <p className="type-sub text-muted-foreground" role="status">
              Try again, or reply and {botName} runs it again with what you
              said.
            </p>
          ) : null}
          <TaskReportView error={report.error} report={report.data} />
        </div>
      </div>
      {conversation.isPending ? null : !conversation.data ? (
        <p className="p-8 text-destructive text-sm" role="alert">
          Couldn't load this task's conversation. Reload the page.
        </p>
      ) : (
        /*
         * ONE CONVERSATION IN EVERY STATE. Failed, working on the server, or waiting on the person,
         * it is the same one, so nothing typed or queued is lost when the task's state changes.
         */
        <ChannelChat
          channel={conversation.data}
          key={conversation.data.id}
          runtimeAgentId={task.botId}
          task={{
            busy: serverTurn,
            queued: task.queuedReplies,
            wordsOnly: replyRunsTask,
            version: [
              task.status,
              task.updatedAt,
              task.queuedReplies.length,
              busy,
            ].join(":"),
            send: async ({ text, messageId, attachmentIds, skillIds }) => {
              clearErrors();
              if (replyRunsTask) {
                try {
                  await again.mutateAsync({
                    id: task.id,
                    reply: text,
                    messageId,
                  });
                  return;
                } catch (error) {
                  // Something else started it again first: the reply waits its turn instead.
                  if (
                    !(error instanceof Error) ||
                    !ALREADY_RUNNING.test(error.message)
                  )
                    throw error;
                  again.reset();
                }
              }
              await reply.mutateAsync({
                id: task.id,
                reply: text,
                messageId,
                ...(attachmentIds ? { attachmentIds } : {}),
                ...(skillIds ? { skillIds } : {}),
              });
            },
          }}
        />
      )}
    </div>
  );
}
