/**
 * A BOT'S LINE IN A CONVERSATION THE LIST DOES NOT HOLD, told to that conversation open now.
 *
 * An open conversation reads its history again when the list says its Bot said something this tab
 * did not stream: a turn the server ran, on another device, or after an approval. It learns that
 * from its own row in the list. A task's thread has no row there: it is kept out of the list on
 * purpose, and reached from its card. So a turn the server carried on in a task's thread (the
 * person's answer to its question, sent while the thread was still loading) was written, announced
 * on the socket like any other, and never read: the thread said the Bot was reading the answer
 * until it was reloaded, with the approval the turn had stopped on nowhere to be seen.
 *
 * So the socket says so here when a Bot's line arrives for a conversation no page of the list holds,
 * and the chat on screen for that conversation reads its history again, as it does for a listed one.
 * In-memory and per tab: the socket's events are this tab's, and so is the chat that hears them.
 */
export type BotLine = { agentId: string; at: string; text: string };

const listeners = new Map<string, Set<(line: BotLine) => void>>();

/** Hear a Bot's lines in this conversation when the list holds no row for it. */
export function onBotSaidOffTheList(
  channelId: string,
  listener: (line: BotLine) => void,
): () => void {
  let forChannel = listeners.get(channelId);
  if (!forChannel) {
    forChannel = new Set();
    listeners.set(channelId, forChannel);
  }
  const heard = forChannel;
  heard.add(listener);
  return () => {
    heard.delete(listener);
    if (heard.size === 0) listeners.delete(channelId);
  };
}

/** A Bot said this in a conversation the list holds no row for. */
export function botSaidOffTheList(channelId: string, line: BotLine): void {
  for (const listener of [...(listeners.get(channelId) ?? [])]) listener(line);
}
