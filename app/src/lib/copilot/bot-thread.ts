import { useCallback, useEffect, useRef, useState } from "react";
import { tryClient } from "@/lib/client";
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
 *
 * "Tomorrow" is a promise this module cannot keep on its own, though. The id survives in
 * `localStorage` forever, but Intelligence is free to forget the thread behind it — expiry,
 * environment reset, a wiped dev database. Remembering an id nobody upstream recognises does not
 * fail loudly: every send just opens a new, empty thread under the old id, and the chat answers as
 * if nothing had ever been said, with no error on screen to explain why. So before this hook hands
 * out a remembered id, it asks Intelligence whether that id still means something, and only keeps
 * pretending the history is there when the answer says it is.
 */

const KEY = "openbot.bot-thread";

/** The one place the storage key is built, so the getter and the setter can never drift apart. */
export function botThreadKey(agentId: string): string {
  return `${KEY}.${agentId}`;
}

function remembered(agentId: string): string | null {
  try {
    return window.localStorage.getItem(botThreadKey(agentId));
  } catch {
    // Storage can be unavailable or full. A thread for this visit is better than no chat at all.
    return null;
  }
}

function remember(agentId: string, threadId: string): void {
  try {
    window.localStorage.setItem(botThreadKey(agentId), threadId);
  } catch {
    // As above: the conversation still works, it just will not be here next time.
  }
}

async function mint(): Promise<string | null> {
  try {
    const response = await tryClient("/api/threads/mint", { method: "POST" });
    if (!response.ok) return null;
    const body = (await response.json()) as { threadId?: unknown };
    return typeof body.threadId === "string" ? body.threadId : null;
  } catch {
    return null;
  }
}

/**
 * Whether Intelligence still has a remembered thread, and whether the question could even be put
 * to it. Those are separate facts: a 404 on this route means no reader is configured on this
 * deployment at all, which says nothing about the thread and must not be read as bad news, while a
 * 400 or a 502 (or the request simply throwing) means the question was asked and failed to get a
 * clean answer.
 */
async function checkKnown(
  threadId: string,
): Promise<{ known: boolean | undefined; unavailable: boolean }> {
  try {
    const response = await tryClient(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (response.status === 404) {
      // The route itself is absent, which is what an unconfigured reader looks like server-side.
      // Behave exactly as this hook did before the check existed: nothing was learned, nothing
      // changes.
      return { known: undefined, unavailable: false };
    }
    if (!response.ok) {
      // A 400 means the remembered id was not even a plausible thread id; a 502 means the check
      // itself failed to reach Intelligence. Either way there is no clean answer, and the safer
      // read is "unknown" rather than "gone" — see threadToUse for why.
      return { known: undefined, unavailable: true };
    }
    const body = (await response.json()) as { known?: unknown };
    if (typeof body.known !== "boolean") {
      // A 200 that does not carry the shape this hook asked for is not an answer either.
      return { known: undefined, unavailable: true };
    }
    return { known: body.known, unavailable: false };
  } catch {
    return { known: undefined, unavailable: true };
  }
}

/**
 * Whether to keep the remembered thread id or start over, given what the check above learned.
 *
 * The two ways of not keeping it are not the same mistake. `known: false` is Intelligence saying,
 * plainly, that it has never heard of this id — replacing it loses nothing, because there was
 * never anything there to lose, and keeping it would only mean sending every message into a thread
 * that quietly reopens empty. `known: undefined` is the opposite kind of ignorance: the check
 * failed to get an answer at all, and discarding somebody's conversation on the strength of a
 * network blip is the worse mistake of the two. So only a provable "no" moves this to `"fresh"`;
 * an inconclusive check keeps what was remembered. No remembered id to keep is its own case: with
 * nothing to protect, there is nothing the check could have told us that would change the outcome.
 */
export function threadToUse(input: {
  remembered: string | null;
  known: boolean | undefined;
}): "remembered" | "fresh" {
  if (input.remembered === null) return "fresh";
  return input.known === false ? "fresh" : "remembered";
}

export type BotThread = {
  /** `undefined` until it is known, which is not the same as absent: rendering the chat before
   * then would let it mint an id of its own, and that is the one this deployment would then be
   * stuck with. */
  threadId: string | undefined;
  /**
   * `"unavailable"` means the check that guards a remembered thread failed to get a clean answer,
   * so this render is going ahead on a thread id that history may or may not still exist for and
   * nobody can currently say which. `"ready"` covers every case where that question was either
   * answered or never needed asking.
   */
  history: "ready" | "unavailable";
  /** Mints a fresh thread and starts using it from now on, independent of whatever was
   * remembered. */
  startNew: () => void;
};

/**
 * The thread the direct Bot chat talks in, resolved once per `agentId` and re-verified on every
 * mount rather than trusted forever — see the module doc for why a remembered id can go stale.
 */
export function useBotThread(agentId: string): BotThread {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<"ready" | "unavailable">("ready");
  // Mirrors the effect's own `current` flag so `startNew` — which runs from an event handler, not
  // from the effect — can tell whether it is still safe to touch state: the agent may have changed
  // or the component may have unmounted while its mint was in flight.
  const mountedRef = useRef(true);
  // Shared between the effect's own resolution mint and `startNew`'s mint so the two can never
  // race each other into two POST /mint calls fighting over the same localStorage slot.
  const mintingRef = useRef(false);

  useEffect(() => {
    let current = true;
    mountedRef.current = true;
    setThreadId(undefined);
    setHistory("ready");

    const adoptFresh = () => {
      mintingRef.current = true;
      void mint().then((minted) => {
        mintingRef.current = false;
        if (!current) return;
        // Falling back to one made here keeps the chat working when the deployment cannot be
        // asked; it is simply a thread nothing can later attribute.
        const next = minted ?? newId();
        if (minted) remember(agentId, minted);
        setThreadId(next);
        setHistory("ready");
      });
    };

    const existing = remembered(agentId);
    if (!existing) {
      // Nothing remembered means nothing the check could protect — minting straight away is both
      // faster and exactly as safe as asking Intelligence about an id that was never assigned.
      adoptFresh();
    } else {
      void checkKnown(existing).then((outcome) => {
        if (!current) return;
        const decision = threadToUse({
          remembered: existing,
          known: outcome.known,
        });
        if (decision === "remembered") {
          setThreadId(existing);
          setHistory(outcome.unavailable ? "unavailable" : "ready");
        } else {
          adoptFresh();
        }
      });
    }

    return () => {
      current = false;
      mountedRef.current = false;
    };
  }, [agentId]);

  const startNew = useCallback(() => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    void mint().then((minted) => {
      mintingRef.current = false;
      if (!mountedRef.current) return;
      // Leaving the current thread alone here matters: a person pressing "New chat" should never
      // end up worse off — mid-conversation and suddenly unable to send — than before they pressed
      // it.
      if (!minted) return;
      remember(agentId, minted);
      setThreadId(minted);
      setHistory("ready");
    });
  }, [agentId]);

  return { threadId, history, startNew };
}
