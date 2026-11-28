/**
 * A Bot sending a file from its computer to the person, into the conversation.
 *
 * The server pulls the file through the computer's governed download (the policy decides, an
 * approval rule may ask, the audit trail records it), checks it as it checks an upload, and stores it
 * as an attachment of the conversation. The answer carries the stored file, and the conversation
 * draws it as a card any member can open (app/src/lib/computers/sent-file.ts).
 *
 * The name and the description are the server's too, for the turns it runs itself: change them
 * together.
 */
import { acceptedFilesInWords } from "./attachments";

export const SEND_FILE_TOOL = "computer_send_file";

/**
 * What a Bot may send is what a person may attach: the one list in attachments.ts
 * (`ACCEPTED_FILE_TYPES`). The description and the refusal both say it from there.
 */
export const SEND_FILE_TOOL_DESCRIPTION = `Send a file from your workspace to the person, into this conversation, where they and everyone in it can open and download it. Use this whenever you made a file for them (a chart, a report, a spreadsheet, a slide deck, a CSV, a PDF) instead of only saying where it is: they cannot reach your computer's files any other way. Give the path relative to your workspace, such as reports/august.pdf. You can send ${acceptedFilesInWords()}; anything else is refused. You are told whether it arrived. It shows in the conversation as a card with its own Download button; to link it in your words, link the url the answer gives, never its path on your computer, which nobody else can open.`;

/** What the person reads when a Bot tried to send a kind of file it can't. */
export function sendFileUnsupported(name: string): string {
  return `${name} can't be sent. Bots can send ${acceptedFilesInWords()}.`;
}

/** What a surface with no conversation to send into answers. */
export const SEND_FILE_NO_CONVERSATION =
  "Files can only be sent in a conversation. Nothing was sent.";
