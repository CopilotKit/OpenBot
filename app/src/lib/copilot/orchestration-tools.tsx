import {
  useCopilotChatConfiguration,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import {
  DELEGATE_TOOL,
  FOLLOW_UP_TOOL,
  LINK_TOOL,
  REACT_TOOL,
  readDelegateResult,
  readLinkResult,
  readTaskActionResult,
  STOP_TOOL,
} from "@openbot/shared/orchestration";
import { useEffect } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { TaskSteer } from "@/components/tasks/task-steer";
import { TaskCard, ThreadLinks } from "@/components/tasks/task-thread";
import { asText, refusalOf } from "@/lib/plugins/tool-result";
import { taskKeys } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/*
 * How a Bot's orchestration calls read in the conversation: `delegate` is the task's card, updated in
 * place, with the latest thing the person told the task in its thread on a line under it; `react`
 * draws nothing of its own, since the reaction is drawn under the person's message;
 * `link_to_thread` is the list of threads it found, each a way in; `follow_up` and `stop` are the
 * card of the task they reached, as it stands now. What a follow-up told the task is the line under
 * the task's first card, said once: not a second time under this one.
 *
 * RENDER ONLY. The three run on the server, where the task is opened and
 * the reaction stored, so nothing here registers a tool or decides anything.
 */

const delegateParameters = z.object({
  title: z.string().optional(),
  brief: z.string().optional(),
});

const reactParameters = z.object({ emoji: z.string().optional() });

const linkParameters = z.object({ about: z.string().optional() });

const followUpParameters = z.object({
  task: z.string().optional(),
  message: z.string().optional(),
});

const stopParameters = z.object({
  task: z.string().optional(),
  said: z.string().optional(),
});

/**
 * The card of the task a `follow_up` or `stop` reached, live: Working again once it was told more,
 * Stopped once it stopped. While the call is on its way, or when no task was reached, a line.
 */
function TaskActionCard({
  result,
  status,
  running,
  refused,
}: {
  result: unknown;
  status: string;
  running: string;
  refused: string;
}) {
  const answer = typeof result === "string" ? asText(result) : undefined;
  const reached = readTaskActionResult(answer);
  if (reached)
    return (
      <TaskCard
        channelId={reached.channelId}
        taskId={reached.taskId}
        title={reached.title}
      />
    );
  /*
   * Not reached: the Bot is told why, in words meant for it, and says so to the person itself. The
   * line says only that nothing was done.
   */
  return (
    <ToolLine
      label={answer !== undefined ? refused : running}
      running={status !== "complete" && result === undefined}
    />
  );
}

/** A reaction landed: the person's message under it reads its reactions again. */
function ReactionLanded({ done }: { done: boolean }) {
  const chat = useCopilotChatConfiguration();
  const threadId = chat?.threadId;
  useEffect(() => {
    if (done && threadId)
      void queryClient.invalidateQueries({
        queryKey: taskKeys.reactions(threadId),
      });
  }, [done, threadId]);
  return null;
}

export function OrchestrationTools() {
  useRenderTool({
    name: DELEGATE_TOOL,
    parameters: delegateParameters,
    render: ({ parameters: given, result }) => {
      const answer = typeof result === "string" ? asText(result) : undefined;
      const started = readDelegateResult(answer);
      const refusal =
        answer !== undefined && !started ? refusalOf(answer) : undefined;
      return (
        <>
          <TaskCard
            brief={given?.brief}
            channelId={started?.channelId}
            refusal={refusal}
            taskId={started?.taskId}
            title={started?.title ?? given?.title?.trim() ?? "New task"}
          />
          {/* What the person has told the task in its thread since, under its card. */}
          {started ? <TaskSteer taskId={started.taskId} /> : null}
        </>
      );
    },
  });

  useRenderTool({
    name: REACT_TOOL,
    parameters: reactParameters,
    render: ({ result }) => <ReactionLanded done={result !== undefined} />,
  });

  useRenderTool({
    name: LINK_TOOL,
    parameters: linkParameters,
    render: ({ parameters: given, result, status }) => {
      const answer = typeof result === "string" ? asText(result) : undefined;
      const found = readLinkResult(answer);
      if (found?.threads.length) return <ThreadLinks threads={found.threads} />;
      return (
        <ToolLine
          detail={given?.about}
          label="Looked for a task thread"
          running={status !== "complete" && result === undefined}
        />
      );
    },
  });

  useRenderTool({
    name: FOLLOW_UP_TOOL,
    parameters: followUpParameters,
    render: ({ result, status }) => (
      <TaskActionCard
        refused="Nothing passed on"
        result={result}
        running="Telling the task"
        status={status}
      />
    ),
  });

  useRenderTool({
    name: STOP_TOOL,
    parameters: stopParameters,
    render: ({ result, status }) => (
      <TaskActionCard
        refused="Nothing stopped"
        result={result}
        running="Stopping the task"
        status={status}
      />
    ),
  });

  return null;
}
