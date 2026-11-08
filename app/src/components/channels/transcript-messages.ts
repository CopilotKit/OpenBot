import type { Message } from "@ag-ui/core";

/**
 * What a transcript shows while a brand-new channel is still joining.
 *
 * NOT DECIDED ON `messages.length`: the runtime replaces its messages wholesale, so the seed would
 * be dropped on the first assistant token with the person's own turn already gone. A role rather
 * than an id, because the agent's copy and the restored copy each mint their own.
 */
export function transcriptMessages(
  messages: readonly Message[],
  seed: Message | null,
): readonly Message[] {
  if (seed === null) {
    return messages;
  }
  if (messages.some((message) => message.role === "user")) {
    return messages;
  }
  return [seed, ...messages];
}

/** The person's message, in the shape the transcript and the agent both take. */
export function seedMessage(text: string, id: string): Message {
  return { id, role: "user", content: text };
}

/**
 * The message a channel was created by, waiting for the screen that will send it.
 *
 * A module-level map rather than router state because `HistoryState` is an empty interface and
 * typing a value into it means augmenting `@tanstack/history`, which is not a dependency of this
 * app. It also earns something router state would not give: taking is destructive, so a component
 * that mounts twice cannot send the same message twice.
 *
 * Deliberately not persisted. A reload finds nothing here, which is correct, by then the message
 * is in the thread and arrives through the normal replay.
 */
export type FirstMessage = {
  /**
   * The words, with a `/` skill still at their start as `/<command>`: the server finds the skill
   * there and gives the Bot its instructions, for the first message as for every later one.
   */
  text: string;
};

const firstMessages = new Map<string, FirstMessage>();

export function stashFirstMessage(channelId: string, text: string): void {
  firstMessages.set(channelId, { text });
}

/** Read the pending first message and forget it. Null for a channel opened any other way. */
export function takeFirstMessage(channelId: string): FirstMessage | null {
  const message = firstMessages.get(channelId) ?? null;
  firstMessages.delete(channelId);
  return message;
}
