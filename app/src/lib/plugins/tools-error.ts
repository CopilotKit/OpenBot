import { readConnectPrompt } from "@openbot/shared/connect-prompt";
import { vendorNameOf } from "@/lib/apps/vendor-name";

/** What a page says about an app's empty tool list, and whether that is a failure. */
export type ToolsListNote = {
  text: string;
  /** True for a failure, drawn in the destructive colour. False for a state that is expected. */
  error: boolean;
};

/**
 * What an app lists its tools as, in the team edition, while nobody it can ask as has connected.
 *
 * An app that signs each person in lists its tools only for somebody who has. The member who wants
 * it connects, and the tools are listed then, so this is a state to describe and not an error.
 * An admin is never told to connect their own account for it.
 */
export function listsToolsOnceConnected(title: string): string {
  return `${vendorNameOf(title)} lists its tools once someone connects their account.`;
}

/**
 * What an app's empty tool list says about the last time its tools were asked for.
 *
 * `lastError` is the server's record of why the last refresh listed nothing, and the refresh runs as
 * the person who pressed it. When that person had not connected the app, the record is the refusal
 * a Bot gets, which opens with the `[connect-app]{...}` marker the chat draws as a card. A page has
 * no card to draw there, so the marker never reaches the screen.
 *
 * In the team edition a `connect` or `reconnect` refusal is about whoever ran the refresh, and their
 * own account is not what the app waits on: it says the app lists its tools once someone connects,
 * as a state and not an error. In the personal edition, a page with a Connect above points its one
 * person at it, because "ask again" is about a conversation and this is a page. Anywhere else, and
 * for any other reason, the refusal's own sentence is shown.
 *
 * Any other record is the server's own sentence, shown as it is.
 */
export function toolsListError(
  lastError: string | null,
  reader: {
    title: string;
    personal: boolean;
    /** Whether the page draws a Connect for this person above the list. */
    connectAbove?: boolean;
  },
): ToolsListNote | null {
  if (lastError === null) return null;
  const prompt = readConnectPrompt(lastError);
  if (!prompt) return { text: lastError, error: true };
  const connecting =
    prompt.reason === undefined ||
    prompt.reason === "connect" ||
    prompt.reason === "reconnect";
  if (!reader.personal && connecting)
    return { text: listsToolsOnceConnected(reader.title), error: false };
  // Actions a Bot wasn't given are not about connecting, so connecting is never the advice.
  if (!reader.personal || !reader.connectAbove || prompt.reason === "tools")
    return prompt.message ? { text: prompt.message, error: true } : null;
  return {
    text:
      prompt.reason === "reconnect"
        ? `Your ${vendorNameOf(reader.title)} access was withdrawn. Reconnect it above to list its tools.`
        : `Connect your ${vendorNameOf(reader.title)} account above to list its tools.`,
    error: true,
  };
}
