/**
 * A Bot deleted for good, forgotten in Intelligence's conversations and delivery bindings.
 *
 * The old foreign keys did this by cascade: a purged Bot's `channel_agents`, `bot_tasks` and
 * `delivery_bindings` rows went with its `agents` row, and a channel's last speaker was cleared.
 * Those rows live in Intelligence now, so the server asks Intelligence to do the same when the Bot
 * directory says a Bot was purged, and at boot for any Bot purged while no instance was running to
 * hear it. A soft delete removes nothing, exactly as before: a deleted Bot's conversations stay.
 */
import type { ConversationDirectory } from "./directory";
import type { DeliveryDirectory } from "../delivery/directory";
import { writeKey } from "./http";

export async function forgetPurgedBot(
  conversations: ConversationDirectory,
  delivery: DeliveryDirectory,
  botId: string,
): Promise<void> {
  await conversations.client.purgeAgent(
    botId,
    writeKey("conversations.purge-agent"),
  );
  // What this instance held named the Bot; the next read takes Intelligence's answer.
  await conversations.resync();
  await delivery.purgeAgent(botId);
}

/**
 * Every Bot the conversations and bindings still name that Intelligence's registry no longer has,
 * forgotten. For the boot: `known` must list every Bot, deleted ones included.
 */
export async function sweepPurgedBotReferences(
  conversations: ConversationDirectory,
  delivery: DeliveryDirectory,
  known: ReadonlySet<string>,
): Promise<string[]> {
  const named = new Set([
    ...(await conversations.client.agentReferences()),
    ...delivery.bindings().map((binding) => binding.agentId),
  ]);
  const gone = [...named].filter((botId) => !known.has(botId));
  for (const botId of gone)
    await forgetPurgedBot(conversations, delivery, botId);
  if (gone.length > 0)
    console.warn(
      JSON.stringify({
        type: "conversation-bot-references-swept",
        bots: gone,
        note: "Conversations and bindings named Bots Intelligence no longer has; they were removed from them as the old cascade would have.",
      }),
    );
  return gone;
}
