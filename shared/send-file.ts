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
export const SEND_FILE_TOOL = "computer_send_file";

export const SEND_FILE_TOOL_DESCRIPTION =
  "Send a file from your workspace to the person, into this conversation, where they and everyone in it can open and download it. Use this whenever you made a file for them (a chart, a report, a CSV, a PDF) instead of only saying where it is: they cannot reach your computer's files any other way. Give the path relative to your workspace, such as reports/august.pdf. Images (PNG, JPEG, GIF, WebP), PDFs, and text, Markdown, CSV and JSON files can be sent. You are told whether it arrived.";

/** What a surface with no conversation to send into answers. */
export const SEND_FILE_NO_CONVERSATION =
  "Files can only be sent in a conversation. Nothing was sent.";
