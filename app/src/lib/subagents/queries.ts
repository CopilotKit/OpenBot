import { subagentThreadId } from "@openbot/shared/subagent";
import { queryOptions } from "@tanstack/react-query";
import {
  readThreadMessages,
  type StoredThread,
} from "@/lib/copilot/thread-messages";

/**
 * A subagent's steps, read from its own thread through the same route a conversation's history is.
 *
 * The thread is its owner's, so the read needs nothing new: the person who started the conversation
 * is the person the subagent ran as. While it is still working there is no result to name the thread,
 * so it is derived from the conversation and the call, as the server derived it.
 */
export const subagentKeys = {
  all: ["subagents"] as const,
  /** `settled` is its own entry, so the read after it finishes is a fresh one, not the last poll. */
  steps: (
    toolCallId: string,
    parentThreadId: string | undefined,
    settled: boolean,
  ) => ["subagents", "steps", toolCallId, { parentThreadId, settled }] as const,
};

export function subagentStepsQueryOptions(input: {
  toolCallId: string;
  /** The conversation the call is in. Enough to find the thread before the result names it. */
  parentThreadId: string | undefined;
  /** The thread the result named, once there is one. */
  threadId: string | undefined;
  agentId: string;
  /** Read again every moment while the subagent is working. */
  live: boolean;
}) {
  const { toolCallId, parentThreadId, threadId, agentId, live } = input;
  return queryOptions({
    queryKey: subagentKeys.steps(toolCallId, parentThreadId, !live),
    queryFn: async (): Promise<StoredThread> =>
      readThreadMessages(
        threadId ?? (await subagentThreadId(parentThreadId ?? "", toolCallId)),
        agentId,
      ),
    enabled: Boolean(threadId ?? parentThreadId),
    refetchInterval: live ? 1500 : false,
    // The steps already drawn stay while the settled read arrives, so the list never blinks empty.
    placeholderData: (previous) => previous,
  });
}
