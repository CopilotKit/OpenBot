/**
 * Whether a row has something to tell the person looking at it.
 *
 * Here rather than in the sidebar component because the sidebar is not the only surface that draws
 * a roster, and because the three sections ask the same question of every row they hold.
 * `app-sidebar.tsx` re-exports both, so what already imported them from there keeps working.
 */
import type { ChannelSummary } from "./queries";

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}
