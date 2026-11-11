/**
 * A run whose live stream reached this browser out of shape, while the run itself went fine.
 *
 * WHAT HAPPENS. A run's events go from the runtime to Intelligence, which stores them and streams
 * them to the browser. The browser joins a run's stream before the run has started, and the gateway
 * waits for the run's first event with a backoff that reaches two seconds. A Bot that takes a
 * couple of seconds to start (a harness reading its tools) is often already streaming when the
 * gateway looks again. It then sends what it has stored so far as one compacted block, and drops
 * every later event of the same message or call whose sequence number is below the highest one in
 * that block. The events of one batch are stored out of order, so the block can hold the third,
 * fifth and last piece of a sentence and not the others: every other piece is then dropped as
 * already sent. Seen on Windows in 1.0.2-rc.1: the reply drew as "ows httpbin's JSON echo of the
 * second other fields are empty." while the stored message was whole.
 *
 * WHAT THE BROWSER MAKES OF IT. The original start of that message or call still arrives after the
 * compacted one, and AG-UI's checks refuse it ("Cannot send 'TEXT_MESSAGE_START' event: A text
 * message with ID ... is already in progress"). The run fails in the browser: its reply keeps the
 * pieces that arrived, the snapshot at its end that would have put it right never applies, and the
 * browser steps it asked for are never taken. In the run after a turn's first, nothing said so.
 *
 * WHAT IS DONE ABOUT IT HERE. The stored thread is whole, so the turn reads the run back from it
 * (`mergeStoredMessages`), and carries on once if the run's browser steps were never taken.
 */

/** AG-UI's own wording when a stream breaks its rules (`verifyEvents` in `@ag-ui/client`). */
const OUT_OF_SHAPE = /^Cannot send '[A-Z_]+' event\b/;

/** Whether a run failed in this browser because its stream arrived out of shape. */
export function isBrokenStream(error: unknown): boolean {
  const said =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return OUT_OF_SHAPE.test(said.trim());
}

/** Said when the turn could not be read back or carried on: never silence. */
export const STREAM_BROKE =
  "Part of this answer didn't come through. Open the conversation again, or ask the Bot to carry on.";
