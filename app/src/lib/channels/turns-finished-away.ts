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
 *
 * AND WHILE IT IS STILL GOING. The chat that comes back joins the thread once, when it opens, and a join carries a run
 * only if one is live on the thread at that moment. A turn is not one run end to end: the message waits a moment in
 * the chat that sent it before its run reaches the server, and a turn that uses the browser ends a run at every step
 * and starts the next one from this tab. Come back in one of those gaps (switch away and straight back after sending,
 * say) and the join found nothing running: the conversation showed no message and no Bot working, the composer was
 * open, and the whole answer appeared at once when the turn was over, minutes later on a long task. So the chat that
 * left also says here that its turn is still going (`turnsGoingAway`) and when each of its runs starts
 * (`runStartedAway`), and the chat on screen shows the Bot working and joins the thread again to stream that run in.
 */
const listeners = new Map<string, Set<() => void>>();

/** Hear about turns of this channel that finish after the chat that started them has gone. */
export function onTurnFinishedAway(
  channelId: string,
  listener: () => void,
): () => void {
  return listen(listeners, channelId, listener);
}

/** A turn of this channel finished after the chat that started it closed. */
export function turnFinishedAway(channelId: string): void {
  for (const listener of [...(listeners.get(channelId) ?? [])]) listener();
}

/**
 * The turns of each channel still going in a chat that has closed. A turn is its own token, so marking one away twice
 * or back twice changes nothing: React mounts a chat's effects twice in development, and a count would drift.
 */
const away = new Map<string, Set<object>>();
const awayListeners = new Map<string, Set<() => void>>();
const runListeners = new Map<string, Set<() => void>>();

/** The chat these turns run in has closed, and they go on without it. */
export function turnsLeftRunning(
  channelId: string,
  turns: Iterable<object>,
): void {
  let forChannel = away.get(channelId);
  let changed = false;
  for (const turn of turns) {
    forChannel ??= new Set();
    if (forChannel.has(turn)) continue;
    forChannel.add(turn);
    changed = true;
  }
  if (!forChannel || !changed) return;
  away.set(channelId, forChannel);
  notify(awayListeners, channelId);
}

/** These turns are no longer going away from their chat: they ended, or the chat came back on screen. */
export function turnsNoLongerAway(
  channelId: string,
  turns: Iterable<object>,
): void {
  const forChannel = away.get(channelId);
  if (!forChannel) return;
  let changed = false;
  for (const turn of turns) changed = forChannel.delete(turn) || changed;
  if (forChannel.size === 0) away.delete(channelId);
  if (changed) notify(awayListeners, channelId);
}

/** How many turns of this channel are going in a chat that has closed. */
export function turnsGoingAway(channelId: string): number {
  return away.get(channelId)?.size ?? 0;
}

/** Hear when that number changes. */
export function onTurnsAwayChanged(
  channelId: string,
  listener: () => void,
): () => void {
  return listen(awayListeners, channelId, listener);
}

/** A run of a turn going away from its chat started: it is live on the thread now. */
export function runStartedAway(channelId: string): void {
  notify(runListeners, channelId);
}

/** Hear when a run of a turn going away from its chat starts. */
export function onRunStartedAway(
  channelId: string,
  listener: () => void,
): () => void {
  return listen(runListeners, channelId, listener);
}

function listen(
  registry: Map<string, Set<() => void>>,
  channelId: string,
  listener: () => void,
): () => void {
  let forChannel = registry.get(channelId);
  if (!forChannel) {
    forChannel = new Set();
    registry.set(channelId, forChannel);
  }
  forChannel.add(listener);
  return () => {
    forChannel.delete(listener);
    if (forChannel.size === 0) registry.delete(channelId);
  };
}

function notify(
  registry: Map<string, Set<() => void>>,
  channelId: string,
): void {
  for (const listener of [...(registry.get(channelId) ?? [])]) listener();
}
