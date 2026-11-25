/**
 * The conversation the phone shows now, so a notification about it shows nothing: the screen already
 * has what the notification says, and refreshes to show it.
 *
 * Set by the conversation screen while it is the screen in front, and cleared when it is left. A
 * notification only reaches the app's own handler while the app is open, so "on screen" needs no
 * other check.
 */
let shown: string | null = null;

/** Show `channelId` as the conversation on screen. Returns what clears it again, if it still is. */
export function showConversation(channelId: string): () => void {
  shown = channelId;
  return () => {
    if (shown === channelId) shown = null;
  };
}

/** The conversation a notification is about: the `channelId` the server put in its data. */
export function conversationOf(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("channelId" in data)) return null;
  const { channelId } = data;
  return typeof channelId === "string" && channelId ? channelId : null;
}

/** Whether a notification is about the conversation on screen now. */
export function aboutShownConversation(data: unknown): boolean {
  return shown !== null && conversationOf(data) === shown;
}
