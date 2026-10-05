import type { Message, ToolCall } from "@ag-ui/core";
import {
  awaitHandoff,
  forgetHandoff,
  hasActiveHandoff,
  type PendingHandoff,
} from "@/lib/computers/handoff";
import { newId } from "@/lib/new-id";
import { repairUnansweredToolCalls } from "./repair-history";

export type HandoffAgent = {
  messages: Message[];
  isRunning: boolean;
  setMessages: (messages: Message[]) => void;
};

/** These are transport placeholders / retryable transport failures, never accepted results. */
function needsAnswer(message: Message): boolean {
  if (message.role !== "tool") return false;
  if (message.content.trim() === "Forwarded to client") return true;
  try {
    const result: unknown = JSON.parse(message.content);
    if (result === "Forwarded to client") return true;
    return Boolean(
      result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false &&
        (("reconnecting" in result && result.reconnecting === true) ||
          ("snapshotRequired" in result && result.snapshotRequired === true)),
    );
  } catch {
    return false;
  }
}

export function findPendingTool(
  messages: Message[],
  pending: PendingHandoff,
): ToolCall | null {
  const call = messages
    .flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []) : [],
    )
    .find(
      (tool) =>
        tool.id === pending.toolCallId &&
        [
          "computer_request_help",
          "computer_navigate",
          "computer_read",
          "computer_snapshot",
        ].includes(tool.function.name),
    );
  if (!call) return null;
  const accepted = messages.some(
    (message) =>
      message.role === "tool" &&
      message.toolCallId === call.id &&
      !needsAnswer(message),
  );
  return accepted ? null : call;
}

/** Resume the restored call on its original channel agent; never add a new user task. */
export async function resumeHandoffTask(
  botId: string,
  pending: PendingHandoff,
  agent: HandoffAgent,
  run: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  const hasCall = agent.messages.some(
    (m) =>
      m.role === "assistant" &&
      m.toolCalls?.some((c) => c.id === pending.toolCallId),
  );
  if (!hasCall)
    throw new Error("The handoff's tool call is not in this conversation.");
  if (!findPendingTool(agent.messages, pending))
    throw new Error("This tool call is already answered.");
  if (agent.isRunning || hasActiveHandoff(botId, pending.requestId))
    throw new Error("This task is already running.");
  const result = await awaitHandoff(botId, pending.requestId, signal);
  if (signal?.aborted) return;
  if (result.reconnecting || result.snapshotRequired)
    throw new Error(
      String(
        result.reason ?? "The computer could not be reached. Retry to resume.",
      ),
    );
  // Another handler/tab may have supplied the result while we waited. Keep accepted work accepted.
  if (!findPendingTool(agent.messages, pending)) return;
  const messages = agent.messages.filter(
    (m) =>
      !(
        m.role === "tool" &&
        m.toolCallId === pending.toolCallId &&
        needsAnswer(m)
      ),
  );
  const caller = messages.findIndex(
    (m) =>
      m.role === "assistant" &&
      m.toolCalls?.some((c) => c.id === pending.toolCallId),
  );
  messages.splice(caller + 1, 0, {
    id: newId(),
    role: "tool",
    toolCallId: pending.toolCallId,
    content: JSON.stringify(result),
  });
  agent.setMessages([...repairUnansweredToolCalls(messages)]);
  forgetHandoff(botId, pending.requestId);
  await run();
}
