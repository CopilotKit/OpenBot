/**
 * The first words of the sentences a server-side tool answers with.
 *
 * DECLARED AT BOTH ENDS, because this crosses a network. A tool that runs on the server reaches the
 * transcript as text meant for a model, so the only thing the renderer can tell an accepted hop from
 * a refused one by is the wording. That is not a contract to be proud of; what makes it survivable
 * is that `app/tests/tool-result.test.ts` reads the server's copies and asserts these still match,
 * so a rewording fails a test rather than a conversation.
 *
 * They live in their own file rather than beside either renderer so the test can import them without
 * pulling in a React component.
 */

/** Matches `HANDED_OVER` in `server/src/agents/handoff-tool.ts`. */
export const HANDED_OVER = "Handed to ";

/** Matches `PUT_TO` in `server/src/agents/escalation.ts`. */
export const PUT_TO = "Put to ";
