/**
 * The first words of the sentences a server-side handoff tool answers with.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. A tool that runs on the server reaches the transcript as
 * text meant for a model, so the only thing the renderer can tell an accepted hop from a refused one
 * by is the wording. That is not a contract to be proud of, and the least it can be is a contract
 * with one author: a rewording here changes the server and the transcript together.
 *
 * It lived in three places once — the server, the renderer, and a test — under a comment claiming it
 * was shared. It was not, and the bug that produced is the one both renderers' comments recount:
 * every accepted hop drawn as Blocked, with the whole suite green.
 */

/** How `message_bot` starts its answer when a hop was accepted. */
export const HANDED_OVER = "Handed to ";

/** How `ask_person` starts its answer when the question was routed. */
export const PUT_TO = "Put to ";

/**
 * What the message id of one Bot's answer to another starts with, when it lands in the
 * conversation that asked.
 *
 * AN INTELLIGENCE THREAD HAS EXACTLY ONE AGENT, so the answer is written into the asking Bot's
 * thread by the deployment rather than by the Bot that wrote it, and the transcript has to be told
 * whose words they are some other way. The id is the one field every reader keeps: the gateway's
 * replay, the thread-messages read a reload restores from, and the browser's own copy. AG-UI's
 * `name` on the message says the same thing and is set too, but the platform's message read drops
 * it, so a transcript keyed on it would lose the attribution on the first reload.
 */
export const ANSWER_ID_PREFIX = "bot-answer:";

/** The id an answer from `botId` carries, unique per delivering run. */
export function answerMessageId(botId: string, runId: string): string {
  return `${ANSWER_ID_PREFIX}${botId}:${runId}`;
}

/**
 * The Bot whose answer this message is, or null for every other message.
 *
 * Split on the LAST colon: the run id after it is a UUID and never holds one, while a Bot id is
 * whatever the deployment named it.
 */
export function answeredBy(messageId: string): string | null {
  if (!messageId.startsWith(ANSWER_ID_PREFIX)) return null;
  const rest = messageId.slice(ANSWER_ID_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  const botId = cut > 0 ? rest.slice(0, cut) : "";
  return botId === "" ? null : botId;
}
