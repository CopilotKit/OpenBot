/**
 * Which socket is allowed to stop the live screen.
 *
 * A Bot's screen has one viewer, and a second `/stream` replaces the first rather than being
 * refused: `open` stops whatever was casting and puts the new socket in the session. What it does
 * not do is close the socket it replaced, because that socket belongs to a client that may still be
 * using it. So the superseded socket closes on its own schedule, and on an ordinary reconnect, where
 * a client opens the new connection before dropping the old one, that is after the replacement is
 * already casting.
 *
 * A `close` handler that stops the session's viewer without asking whether the closing socket is the
 * one casting therefore stops the wrong viewer. The screen the person just reconnected to goes quiet,
 * and their input is dropped without a word, because the input path checks for a viewer before it
 * checks anything it could report. Both failures are silent; the browser is fine, the Bot is fine,
 * and the person is looking at a still image.
 *
 * It lives in its own file for the reason `bot-id.ts` and `authorisation.ts` do: `index.ts` imports
 * Playwright at module scope, so anything left in it needs Chrome merely to be imported by a test.
 * The decision is here and the stopping stays there, the same split `browser-eviction.ts` makes.
 */

/**
 * Is this socket the one currently casting?
 *
 * By identity, never by value. Two sockets are distinct objects however alike they look, and an
 * equality that compared their contents would put the bug back for any pair that happened to match.
 */
export function isCurrentViewer(
  current: { socket: unknown } | undefined,
  socket: unknown,
): boolean {
  return current?.socket === socket;
}
