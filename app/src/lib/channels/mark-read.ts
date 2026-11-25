import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { inSight } from "@/lib/notifications/show";
import { markChannelReadMutationOptions } from "./mutations";
import { channelListQueryOptions } from "./queries";

const runEndListeners = new Map<string, Set<() => void>>();

/**
 * A run in this conversation ended here, however it ended: an answer, an error, or a card waiting on
 * the person. Said by the chat that streamed it, so the conversation open on screen is marked read
 * even when the roster never hears of the end: a failed run and a card with no words are not
 * reported as activity, and a task's thread has no row in the roster at all.
 */
export function runEndedIn(channelId: string): void {
  for (const listener of [...(runEndListeners.get(channelId) ?? [])])
    listener();
}

function onRunEndedIn(channelId: string, listener: () => void): () => void {
  let heard = runEndListeners.get(channelId);
  if (!heard) {
    heard = new Set();
    runEndListeners.set(channelId, heard);
  }
  const forChannel = heard;
  forChannel.add(listener);
  return () => {
    forChannel.delete(listener);
    if (forChannel.size === 0) runEndListeners.delete(channelId);
  };
}

/**
 * Whether OpenBot is in front of the person now (`inSight`: its page shown and its window focused),
 * kept current as they switch away and back.
 */
function useInSight(): boolean {
  const [seen, setSeen] = useState(inSight);
  useEffect(() => {
    const update = () => setSeen(inSight());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return seen;
}

/** How often a mark owed while OpenBot is out of sight checks again whether the person is back. */
const RECHECK_MS = 1_000;

/**
 * Opening a conversation marks it read; a Bot replying while it is open marks it read again, and so
 * does any run in it ending (`runEndedIn`). Used by every screen that shows one conversation, one Bot
 * or several.
 *
 * ONLY WHILE THE PERSON CAN SEE IT. A conversation left open in a window behind others, or in OpenBot
 * Desktop while the person is away from the computer, is not read: what the Bot said there waits as
 * unread until they come back to it. The server tells the person's phone about an answer that is
 * still unread a while after it ended, so marking it read unseen would keep that from them, and not
 * marking it read when they did see it would tell them about what they just watched.
 *
 * EVERY OPEN MARKS IT, not only one the roster says is unseen. A run that ended while the person was
 * in another conversation, a failed one or one that ended on a card with no words, never reaches the
 * roster, and a task's thread has no row there at all: opened again, they are reading it.
 *
 * WHETHER THEY CAN SEE IT IS ASKED AT THE MOMENT OF MARKING (`inSight`), not taken from the last
 * focus event: with focus inside a frame on the page, switching to another app tells this window
 * nothing. A mark owed while out of sight asks again every `RECHECK_MS`, since coming back into a
 * frame tells this window nothing either.
 *
 * Read off the roster the sidebar renders, since the socket keeps its lastMessageAt live: it is the
 * one honest source for "has something new been said". Keyed on primitives, deliberately: the
 * optimistic patch changes the row OBJECT without changing these values, so an object dependency
 * would re-fire on its own write — and with lastMessageAt ahead of this browser's clock, loop.
 */
export function useMarkOpenChannelRead(channelId: string) {
  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  // What re-runs the marking promptly when the person comes back; the marking asks `inSight` itself.
  const seen = useInSight();
  /*
   * The conversation a mark is owed for, opened or a run ended in it since it was last marked. Owed
   * for any conversation this hook has not marked yet, so a route that changes conversation without
   * remounting marks the new one on open too.
   */
  const [marked, setMarked] = useState<string | null>(null);
  const owed = marked !== channelId;
  useEffect(() => onRunEndedIn(channelId, () => setMarked(null)), [channelId]);
  // Marked once the roster is in, so its first page doesn't arrive after the mark saying "unseen".
  const loaded = roster.status !== "pending";
  const markReadMutate = markRead.mutate;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seen` re-runs it when the person comes back
  useEffect(() => {
    if (!loaded || !(unseen || owed)) return;
    const mark = () => {
      setMarked(channelId);
      markReadMutate(channelId);
    };
    if (inSight()) {
      mark();
      return;
    }
    const recheck = setInterval(() => {
      if (!inSight()) return;
      clearInterval(recheck);
      mark();
    }, RECHECK_MS);
    return () => clearInterval(recheck);
  }, [channelId, loaded, unseen, owed, seen, markReadMutate]);
}
