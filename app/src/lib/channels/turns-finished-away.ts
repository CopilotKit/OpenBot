/**
 * A TURN THAT FINISHED AFTER ITS CONVERSATION CLOSED, told to the same conversation open now.
 *
 * A turn outlives the screen it was started on. Leaving a conversation while the Bot is waiting on a browser step (the
 * person holding control, say) unmounts the chat but not the turn: the waiting tool call is a promise in this tab, and
 * when the person hands back it takes its answer and the Bot's next run goes ahead and is stored. The conversation they
 * come back to is a new chat with an agent of its own, which restored history once, before that reply existed. Nothing
 * else tells it: the reply was never streamed into it, and the roster's activity line is written by the chat that left.
 *
 * So the chat that left says so here when its turn ends, and the chat on screen for that channel reads history again.
 * In-memory and per tab, which is exactly the reach of the problem: a turn can only carry on in the tab that ran it.
 */
const listeners = new Map<string, Set<() => void>>();

/** Hear about turns of this channel that finish after the chat that started them has gone. */
export function onTurnFinishedAway(
  channelId: string,
  listener: () => void,
): () => void {
  let forChannel = listeners.get(channelId);
  if (!forChannel) {
    forChannel = new Set();
    listeners.set(channelId, forChannel);
  }
  forChannel.add(listener);
  return () => {
    forChannel.delete(listener);
    if (forChannel.size === 0) listeners.delete(channelId);
  };
}

/** A turn of this channel finished after the chat that started it closed. */
export function turnFinishedAway(channelId: string): void {
  for (const listener of [...(listeners.get(channelId) ?? [])]) listener();
}
