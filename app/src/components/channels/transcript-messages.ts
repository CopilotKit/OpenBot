import type { Message } from "@ag-ui/core";

/**
 * What a transcript shows while a brand-new channel is still joining.
 *
 * Channel join replaces the agent's local messages with restored thread history. The first message
 * is held here as a seed until restored messages arrive, then ignored to avoid duplicate rendering.
 */
export function transcriptMessages(
  messages: readonly Message[],
  seed: Message | null,
): readonly Message[] {
  if (messages.length > 0 || seed === null) {
    return messages;
  }
  return [seed];
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
const firstMessages = new Map<string, string>();

export function stashFirstMessage(channelId: string, text: string): void {
  firstMessages.set(channelId, text);
}

/** Read the pending first message and forget it. Null for a channel opened any other way. */
export function takeFirstMessage(channelId: string): string | null {
  const text = firstMessages.get(channelId) ?? null;
  firstMessages.delete(channelId);
  return text;
}
