import type { Attachment } from "@copilotkit/react-core/v2";
import {
  readSavedDraft,
  savedDraftKey,
  toSavedStagedFile,
  writeSavedDraft,
} from "./saved-draft";

/**
 * A NEW CONVERSATION'S FIRST MESSAGE, KEPT IN THIS BROWSER UNTIL THE SERVER HAS IT.
 *
 * A conversation started from home, a new conversation or a suggestion opens with its first message
 * already showing, and the page sends it a moment later (`ChannelChat`). A page closed, reloaded or
 * killed in that moment never sent it: the conversation was made, and opened again empty, with the
 * words gone. So the message is kept here from the moment its conversation exists until the server
 * has started the run that answers it. Opened again after a page that never got that far, the
 * conversation reads its thread, and only if the server never got the message does it put the words
 * and files back in its message box (`putBackFirstMessage`), for the person to send. They are never
 * sent again by themselves.
 *
 * Kept as a saved draft of its own (`saved-draft.ts`), under the person and the organization, so it
 * is somebody's, and is forgotten after as long as any draft.
 */

/** Where a conversation's kept first message is, beside its own draft. */
function keptKey(channelId: string): string | undefined {
  return savedDraftKey(`first:${channelId}`);
}

/** The conversation's own draft: what its message box reads as it opens. */
function draftKeyOf(channelId: string): string | undefined {
  return savedDraftKey(`conversation:${channelId}`);
}

/**
 * The conversations whose first message this page is sending itself. Never put back here: this
 * page holds the message, and its own send decides what becomes of it.
 */
const sendingHere = new Set<string>();

/** Keep a new conversation's first message until the server has it. */
export function keepFirstMessage(
  channelId: string,
  text: string,
  attachments: readonly Attachment[] = [],
): void {
  sendingHere.add(channelId);
  const key = keptKey(channelId);
  if (!key) return;
  const now = Date.now();
  writeSavedDraft(key, {
    segments: text ? [{ type: "text", text }] : [],
    staged: attachments.flatMap((attachment) => {
      const file = toSavedStagedFile(attachment, now);
      return file ? [file] : [];
    }),
    heldFiles: 0,
    savedAt: now,
  });
}

/** The server has the first message: nothing is left to put back. */
export function forgetFirstMessage(channelId: string): void {
  const key = keptKey(channelId);
  if (key) writeSavedDraft(key, undefined);
}

/**
 * Settle a first message an earlier page kept, once the conversation's thread has been read.
 * `delivered`: the thread shows the server got it (a message of the person's, or a run), and the
 * kept copy is let go. Otherwise it is put back as the conversation's own draft, unless the person
 * has typed one there since. Answers whether it was put back, so the message box can read it.
 */
export function putBackFirstMessage(
  channelId: string,
  delivered: boolean,
): boolean {
  if (sendingHere.has(channelId)) return false;
  const key = keptKey(channelId);
  const draftKey = draftKeyOf(channelId);
  if (!key || !draftKey) return false;
  const kept = readSavedDraft(key);
  if (!kept) return false;
  writeSavedDraft(key, undefined);
  if (delivered || readSavedDraft(draftKey)) return false;
  writeSavedDraft(draftKey, { ...kept, savedAt: Date.now() });
  return true;
}

/** For a test: forget which first messages this page is sending, as a new page would. */
export function forgetSendingHere(): void {
  sendingHere.clear();
}
