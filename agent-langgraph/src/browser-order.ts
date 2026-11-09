/**
 * Answer one step's tool calls: the computer's one after another, in the order the model made them, and everything
 * else alongside.
 *
 * A Bot has one browser. A model that calls tools in parallel sends a form's fields in one step, and side by side they
 * took the focus from each other; a click on Save could overtake the typing before it. The computer also takes its
 * actions one at a time, but only in the order they reach it, which calls sent together do not promise.
 *
 * The answers come back in the order of the calls, whichever finished first.
 */
export async function answerInOrder<Call extends { name: string }, Answer>(
  calls: readonly Call[],
  answer: (call: Call) => Promise<Answer>,
): Promise<Answer[]> {
  let browser: Promise<unknown> = Promise.resolve();
  return Promise.all(
    calls.map((call) => {
      if (!call.name.startsWith("computer_")) return answer(call);
      const turn = browser.then(() => answer(call));
      browser = turn.catch(() => undefined);
      return turn;
    }),
  );
}
