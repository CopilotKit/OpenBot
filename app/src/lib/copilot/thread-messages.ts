import type { Message } from "@ag-ui/core";
import { tryClient } from "@/lib/client";

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * A plain fail-closed function rather than a query. Nothing caches it — the transcript this seeds is
 * then owned by the running agent, so a cached copy would be a second version of the same
 * conversation — and an unreadable history is not a reason to keep somebody from typing. Every
 * failure returns nothing and lets the composer open.
 */
export async function readThreadMessages(
  threadId: string,
  agentId: string,
): Promise<Message[]> {
  try {
    const response = await tryClient(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
    );
    if (!response.ok) return [];
    const stored = (await response.json())?.messages;
    return Array.isArray(stored) ? (stored as Message[]) : [];
  } catch {
    return [];
  }
}
