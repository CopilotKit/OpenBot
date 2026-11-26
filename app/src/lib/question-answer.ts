/**
 * The id a person's answer to a Bot's question is stored under: `person-response:<question id>`.
 * The browser sends it under that id and it is kept under the same one, so a reload reads back the
 * same row.
 */
export const ANSWER_PREFIX = "person-response:";

/** Whether a message is the person answering a question the Bot asked them. */
export function isAnswerToQuestion(messageId: string): boolean {
  return messageId.startsWith(ANSWER_PREFIX);
}
