import { router } from "expo-router";
import { ORGANIZATION_ID } from "./api";
import { createConversation } from "./api/generated/conversations/conversations";

/**
 * Open a conversation with one of the Bots the person can use, or a group with several. `fromSheet`
 * closes the sheet it was picked in first, so the conversation opens on the app's own stack.
 */
export async function openConversationWith(
  bot: string | string[],
  fromSheet = false,
) {
  const botIds = typeof bot === "string" ? [bot] : bot;
  const botId = botIds[0] ?? "";
  // The API hands back the conversation the person already has with this Bot, or starts one; two or more Bots
  // start a group, every Bot on one transcript.
  const { conversation } = await createConversation(ORGANIZATION_ID, {
    botIds,
    ...(botIds.length > 1 ? { group: true } : {}),
  });
  if (fromSheet) router.dismiss();
  router.push({
    pathname: "/conversation",
    params: { channelId: conversation.id, agentId: botId },
  });
}
