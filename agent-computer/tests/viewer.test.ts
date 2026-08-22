import { describe, expect, test } from "bun:test";
import { isCurrentViewer } from "../src/viewer";

/**
 * Which socket is allowed to stop the live screen.
 *
 * One viewer per Bot, and a second `/stream` replaces the first: `open` stops whatever was casting
 * and puts the new socket in the session. The old socket is not closed by that, so its `close`
 * arrives whenever the client gets round to it, which on an ordinary make-before-break reconnect is
 * after the replacement is already running. A close that stops the current viewer without asking
 * whether it owns it stops the wrong one, and the person who just reconnected gets a screen that
 * never updates and input that goes nowhere.
 *
 * The decision rather than the stopping. Stopping a cast is Playwright's job and is not where the
 * wrong answer was; `browser-eviction.ts` splits the same way and for the same reason.
 */
describe("deciding whether a closing socket stops the live screen", () => {
  const socket = { id: "a" };
  const other = { id: "b" };

  test("the socket that is casting stops it", () => {
    expect(isCurrentViewer({ socket }, socket)).toBe(true);
  });

  test("a socket that was replaced stops nothing", () => {
    // The bug this exists for. The old socket closes after the new one has taken over, and without
    // this the new viewer is the one that gets stopped.
    expect(isCurrentViewer({ socket: other }, socket)).toBe(false);
  });

  test("a close with no viewer at all stops nothing", () => {
    // Both sockets gone, or the cast never started. There is nothing to stop and nothing to get wrong.
    expect(isCurrentViewer(undefined, socket)).toBe(false);
  });

  test("identity, not shape", () => {
    // Two sockets are never equal by value, and comparing them that way would put the bug back for
    // any pair that happened to look alike.
    expect(isCurrentViewer({ socket: { id: "a" } }, { id: "a" })).toBe(false);
  });
});
