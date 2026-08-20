import { useEffect, useState } from "react";
import { newId } from "../new-id";

/**
 * The thread the direct Bot chat talks in.
 *
 * Two things it has to be. Minted by this deployment, so the conversation says where it came from
 * in a project that may hold more than one. And the same one tomorrow, because a chat that takes a
 * new thread on every load has no history to come back to.
 *
 * Kept per Bot: the chat is bound to one Bot at a time, and two Bots sharing a thread would read
 * each other's conversation.
 */

const KEY = "openbot.bot-thread";

function remembered(agentId: string): string | null {
  try {
    return window.localStorage.getItem(`${KEY}.${agentId}`);
  } catch {
    // Storage can be unavailable or full. A thread for this visit is better than no chat at all.
    return null;
  }
}

function remember(agentId: string, threadId: string): void {
  try {
    window.localStorage.setItem(`${KEY}.${agentId}`, threadId);
  } catch {
    // As above: the conversation still works, it just will not be here next time.
  }
}

async function mint(): Promise<string | null> {
  try {
    const response = await fetch("/api/threads/mint", {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { threadId?: unknown };
    return typeof body.threadId === "string" ? body.threadId : null;
  } catch {
    return null;
  }
}

/**
 * `undefined` until it is known, which is not the same as absent: rendering the chat before then
 * would let it mint an id of its own, and that is the one this deployment would then be stuck with.
 */
export function useBotThread(agentId: string): string | undefined {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    setThreadId(undefined);

    const existing = remembered(agentId);
    if (existing) {
      setThreadId(existing);
      return;
    }

    void mint().then((minted) => {
      if (!current) return;
      // Falling back to one made here keeps the chat working when the deployment cannot be asked;
      // it is simply a thread nothing can later attribute.
      const next = minted ?? newId();
      if (minted) remember(agentId, minted);
      setThreadId(next);
    });

    return () => {
      current = false;
    };
  }, [agentId]);

  return threadId;
}
