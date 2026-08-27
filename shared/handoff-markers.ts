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
