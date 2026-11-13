import {
  useCopilotChatConfiguration,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import {
  DELEGATE_TOOL,
  LINK_TOOL,
  REACT_TOOL,
  readDelegateResult,
  readLinkResult,
} from "@openbot/shared/orchestration";
import { useEffect } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { TaskCard, ThreadLinks } from "@/components/tasks/task-thread";
import { asText, refusalOf } from "@/lib/plugins/tool-result";
import { taskKeys } from "@/lib/tasks/queries";
import { queryClient } from "@/query-client";

/*
 * How a Bot's orchestration calls read in the conversation: `delegate` is the task's card, updated in
 * place; `react` draws nothing of its own, since the reaction is drawn under the person's message;
 * `link_to_thread` is the list of threads it found, each a way in.
 *
 * RENDER ONLY. The three run on the server (tasks/orchestration.ts), where the task is opened and
 * the reaction stored, so nothing here registers a tool or decides anything.
 */

const delegateParameters = z.object({
  title: z.string().optional(),
  brief: z.string().optional(),
});

const reactParameters = z.object({ emoji: z.string().optional() });

const linkParameters = z.object({ about: z.string().optional() });

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
        <TaskCard
          brief={given?.brief}
          channelId={started?.channelId}
          refusal={refusal}
          taskId={started?.taskId}
          title={started?.title ?? given?.title?.trim() ?? "New task"}
        />
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

  return null;
}
