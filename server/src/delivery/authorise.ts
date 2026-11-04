import { groupSourceForRun } from "../channels/group";
import type { DeliveryScopeResolver } from "./routes";
import type { DeliveryScope } from "./types";

/**
 * Whether a delivery scope still names a conversation its owner can reach, on a thread of theirs in it.
 *
 * That is the conversation's own thread or, in a group conversation, the owner's Bot's own thread
 * there. A Bot's turn in a group runs on a thread of its own (channels/group.ts), so what it raises
 * mid-turn (the owner's permission to share with the group, an approval, a question) is notified on
 * that thread. FOUND IN THE BROWSER: checked against the conversation's thread alone, each of those
 * was refused as "Conversation access has been revoked." as soon as a second person joined a group
 * and the first share approval was raised, so every Bot in the group failed.
 *
 * The Bot's thread is held to the same checks a run on it is (`groupSourceForRun`): the owner still a
 * member of the live conversation, and the thread that owner's, for that Bot.
 */
export function createDeliveryScopeAuthoriser(
  scopeFor: DeliveryScopeResolver,
): (scope: DeliveryScope) => Promise<boolean> {
  return async (scope) => {
    const current = await scopeFor(
      scope.ownerUserId,
      scope.channelId,
      scope.agentId,
    );
    if (!current) return false;
    if (current.threadId === scope.threadId) return true;
    const group = await groupSourceForRun({
      threadId: scope.threadId,
      actorId: scope.ownerUserId,
      botId: scope.agentId,
    });
    return (
      group?.channelId === scope.channelId && group.botId === scope.agentId
    );
  };
}
