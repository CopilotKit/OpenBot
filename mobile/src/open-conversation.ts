import { router } from "expo-router";
import { ORGANIZATION_ID } from "./api";
import { createConversation } from "./api/generated/conversations/conversations";

/**
 * Open a conversation with one of the Bots the person can use. `fromSheet` closes the sheet it was
 * picked in first, so the conversation opens on the app's own stack.
 */
export async function openConversationWith(botId: string, fromSheet = false) {
  // The API hands back the conversation the person already has with this Bot, or starts one.
  const { conversation } = await createConversation(ORGANIZATION_ID, {
    botIds: [botId],
  });
  if (fromSheet) router.dismiss();
  router.push({
    pathname: "/conversation",
    params: { channelId: conversation.id, agentId: botId },
  });
}
