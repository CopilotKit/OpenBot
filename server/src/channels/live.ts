/**
 * Intelligence's conversation announcements, delivered to the browsers connected to this instance.
 *
 * A conversation's stored facts live in Intelligence, which announces each change to every replica
 * (conversations/directory.ts). Each replica reads the conversation that changed and tells its own
 * connected members, in the shape the browser already understands (`ChannelActivityEvent`). This is
 * what `pg_notify('channel_activity', …)` from the writer used to do for those facts.
 *
 * Announcements can be lost while the subscription is down. Every open browser is then told to
 * refetch (`resyncAll`), exactly as the Postgres listener does after it reconnects: the roster read
 * stays the source of truth, and the socket is an optimisation.
 */
import type {
  ConversationChange,
  ConversationDirectory,
} from "../conversations/directory";
import type { ChannelEventHub } from "./events";

export function deliverConversationChanges(
  directory: ConversationDirectory,
  hub: ChannelEventHub,
): () => void {
  const deliver = async (change: ConversationChange) => {
    if (
      change.change !== "activity" &&
      change.change !== "summary" &&
      change.change !== "member" &&
      change.change !== "deleted"
    )
      return;
    // Nobody here to tell: no read at all.
    if (!hub.hasConnections()) return;
    const conversation = await directory.get(change.conversationId);
    if (!conversation) return;
    const memberIds = conversation.members.map((member) => member.userId);
    if (!memberIds.some((userId) => hub.connectionCount(userId) > 0)) return;
    const quiet = {
      channelId: conversation.id,
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
    };
    switch (change.change) {
      case "activity":
        if (conversation.deletedAt !== null) return;
        hub.deliver({
          channelId: conversation.id,
          memberIds,
          lastMessage: conversation.lastMessage,
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
          lastMessageAgentId: conversation.lastMessageAgentId,
        });
        return;
      case "summary":
        if (conversation.deletedAt !== null || conversation.summary === null)
          return;
        hub.deliver({ ...quiet, memberIds, summary: conversation.summary });
        return;
      case "member": {
        // A pin is one member's: it goes to that member's own tabs and nobody else's.
        const member = conversation.members.find(
          (candidate) => candidate.userId === change.userId,
        );
        if (!member || conversation.deletedAt !== null) return;
        hub.deliver({
          ...quiet,
          memberIds: [member.userId],
          pinned: member.pinnedAt !== null,
        });
        return;
      }
      case "deleted":
        // Every member, because the deletion hides the channel for all of them.
        hub.deliver({ ...quiet, memberIds, deleted: true });
        return;
    }
  };
  const stopChanges = directory.onChange((change) => {
    deliver(change).catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "channel-live-delivery-failed",
          conversationId: change.conversationId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  });
  const stopResync = directory.onResync(() => hub.resyncAll());
  return () => {
    stopChanges();
    stopResync();
  };
}
