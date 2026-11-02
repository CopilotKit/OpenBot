import { START_TASK_TOOL } from "@openbot/shared/task-brief";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ChatTaskCard, type StartedTask } from "@/components/tasks/task-card";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";

/*
 * How a Bot handing work to a task reads in the conversation it was asked in.
 *
 * RENDER ONLY, as the handoff beside it: `start_task` runs on the server (server/src/tasks/tools.ts),
 * which opens the task and its conversation. What this draws is the task's card under the Bot's "On
 * it", opening the task's page. The transcript moves the card to the end of its turn
 * (`startedTasksLast` in chat-messages.ts).
 */

const parameters = z.object({ title: z.string().optional() });

const startedSchema = z.object({
  taskId: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string(),
});

/** The tool's answer, or null for a refusal or anything that is not a started task. */
export function readStartedTask(result: unknown): StartedTask | null {
  if (typeof result !== "string" || asText(result).startsWith(REFUSAL_MARKER))
    return null;
  try {
    let value: unknown = JSON.parse(result);
    // A server tool's text can arrive JSON-encoded once more on the way through the runtime.
    if (typeof value === "string") value = JSON.parse(value);
    const parsed = startedSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function TaskCardTool() {
  useRenderTool({
    name: START_TASK_TOOL,
    parameters,
    render: ({ result, status }) => {
      if (status !== "complete" && result === undefined)
        return <ToolLine label="Starting a task" running />;
      const started = readStartedTask(result);
      // Nothing for a refusal: the Bot is told what to fix and tries again.
      return started ? <ChatTaskCard started={started} /> : null;
    },
  });
  return null;
}
