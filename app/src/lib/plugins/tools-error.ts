import { readConnectPrompt } from "@openbot/shared/connect-prompt";

/**
 * What an app's empty tool list says about the last time its tools were asked for.
 *
 * `lastError` is the server's record of why the last refresh listed nothing, and the refresh runs as
 * the person who pressed it. When that person had not connected the app, the record is the refusal
 * a Bot gets, which opens with the `[connect-app]{...}` marker the chat draws as a card. A page has
 * no card to draw there, so the marker never reaches the screen: the team edition shows the
 * refusal's own sentence, and the personal edition points its one person at the Connect above,
 * because "ask again" is about a conversation and this is a page.
 *
 * Any other record is the server's own sentence, shown as it is.
 */
export function toolsListError(
  lastError: string | null,
  reader: { title: string; personal: boolean },
): string | null {
  if (lastError === null) return null;
  const prompt = readConnectPrompt(lastError);
  if (!prompt) return lastError;
  if (!reader.personal) return prompt.message || null;
  return prompt.reason === "reconnect"
    ? `Your ${reader.title} access was withdrawn. Reconnect it above to list its tools.`
    : `Connect your ${reader.title} account above to list its tools.`;
}
