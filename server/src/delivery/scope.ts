import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { groupSourceForRun } from "../channels/group";
import type { ChannelStore } from "../channels/routes";
import type { Database } from "../db/client";
import type { PeopleStore } from "../people/store";
import type { DeliveryScopeResolver } from "./routes";
import type { DeliveryScope } from "./types";

/**
 * Where delivery may speak for a Bot: the person's conversation with it, and whether a scope still
 * names one they can reach.
 *
 * `scopeFor` is the conversation as delivery addresses it, by its own thread. `authorise` is asked
 * before anything is sent or run in a scope, and once more when a queued message goes out.
 *
 * A BOT IN A GROUP CONVERSATION WORKS IN A THREAD OF ITS OWN. An Intelligence thread admits one
 * agent, so each Bot in a group runs in its own group thread (`group_bot_threads`), never in the
 * channel's. A question that Bot puts to the person carries that thread. Checked against the
 * channel's thread alone, every one was refused as "Conversation access has been revoked": the Bot
 * told the person it could not ask, while the question it had saved waited behind a badge that
 * nothing in the conversation could answer. The Bot's own group thread is its conversation too,
 * under the same checks the coordination tools apply (`groupSourceForRun`): the person still a
 * member of a live channel, the thread theirs, and the Bot that thread's own.
 */
export function createDeliveryScopes(deps: {
  database: Database;
  people: Pick<PeopleStore, "find">;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channels: Pick<ChannelStore, "get">;
  bots: Pick<AgentProfileStore, "get">;
}) {
  const scopeFor: DeliveryScopeResolver = async (
    ownerUserId,
    channelId,
    agentId,
  ) => {
    const person = await deps.people.find(ownerUserId);
    if (!person || person.revoked) return null;
    const actor = await deps.actorFor(ownerUserId);
    const [channel, bot] = await Promise.all([
      deps.channels.get(actor, channelId),
      deps.bots.get(actor, agentId),
    ]);
    return channel?.active && bot && channel.agentIds.includes(agentId)
      ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
      : null;
  };
  const authorise = async (scope: DeliveryScope) => {
    const current = await scopeFor(
      scope.ownerUserId,
      scope.channelId,
      scope.agentId,
    );
    if (!current) return false;
    if (current.threadId === scope.threadId) return true;
    const group = await groupSourceForRun(deps.database, {
      threadId: scope.threadId,
      actorId: scope.ownerUserId,
      botId: scope.agentId,
    });
    return group?.channelId === scope.channelId;
  };
  return { scopeFor, authorise };
}
