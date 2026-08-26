import { describe, expect, test } from "bun:test";
import { createSessions } from "../src/sessions";

/**
 * Which run of a Bot's browser the server is looking at.
 *
 * A snapshot's generation orders snapshots within one run and says nothing across two. The counter
 * lives here, in a map this process keeps, and it restarts at one whenever the session behind it is
 * new: a container restart, an eviction from the idle sweep, or a redeploy. None of those tell the
 * server anything, so a generation the server still holds from the run before matches a row nothing
 * has overwritten, and the boundary decides about an element on a page that no longer exists.
 *
 * The run is what carries that difference. It is minted with the session and changes whenever the
 * session does, so the server can order across two of them rather than only within one.
 *
 * These test the bookkeeping rather than the browser. `index.ts` imports Playwright at module scope,
 * so a test that reached the handlers would drag a browser runtime in with it, which is the same
 * reason `browser-eviction.ts` and `profile-listing.ts` are their own modules.
 */

/** A mint that counts, so a test can name the run it expects rather than match a uuid. */
function counting(): () => string {
  let next = 0;
  return () => `run-${++next}`;
}

describe("the run a session carries", () => {
  test("a Bot's first session is given one", () => {
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    expect(sessions.for("bot-1").run).toBe("run-1");
  });

  test("the same session keeps it", () => {
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    sessions.for("bot-1");
    expect(sessions.for("bot-1").run).toBe("run-1");
  });

  test("two Bots do not share one", () => {
    // They share this process, and nothing else. A run that identified the container rather than the
    // session would be the same string for every Bot on the one shared computer, and ordering across
    // runs would never fire for any of them.
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    expect(sessions.for("bot-1").run).not.toBe(sessions.for("bot-2").run);
  });

  test("a session the idle sweep dropped comes back as a new run", () => {
    /*
     * The eviction path, which is the one that made the generation ambiguous in the first place.
     * `forgetIdleSessions` drops a Bot with no live browser once the map is over its cap, and the
     * next request mints a session counting from generation one again. Reusing the run would say
     * "same run, older generation" about a browser that has been gone and back.
     */
    const sessions = createSessions({
      isLive: () => false,
      mintRun: counting(),
      cap: 1,
    });
    const first = sessions.for("bot-1").run;
    // Over the cap, so the sweep runs and takes the idle Bot with it.
    sessions.for("bot-2");
    expect(sessions.for("bot-1").run).not.toBe(first);
  });

  test("a Bot whose browser is running is not swept, and keeps its run", () => {
    // The control. A sweep that dropped everything would pass the test above while breaking every
    // ref a working Bot holds.
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
      cap: 1,
    });
    const first = sessions.for("bot-1").run;
    sessions.for("bot-2");
    expect(sessions.for("bot-1").run).toBe(first);
  });

  test("a Bot somebody is watching is not swept either", () => {
    const sessions = createSessions({
      isLive: () => false,
      mintRun: counting(),
      cap: 1,
    });
    const watched = sessions.for("bot-1");
    // Through the slot's own claim, not by assigning the field: occupancy starts at the claim, so a
    // test that set some other shape would pass while the sweep read the real one.
    watched.viewer.claim({}, () => undefined);
    sessions.for("bot-2");
    expect(sessions.for("bot-1").run).toBe(watched.run);
  });
});

describe("renewing a run", () => {
  test("a reset gives the Bot a new one", () => {
    /*
     * A reset wipes the profile and closes the browser, and the session survives it: the map is not
     * touched, so the generation counter carries on from where it was. Without a new run the server
     * cannot tell a save that was in flight when the wipe landed from the fresh browser's own, and
     * the wiped page comes back with nothing later willing to refuse it.
     */
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    const before = sessions.for("bot-1").run;
    expect(sessions.renewRun("bot-1")).not.toBe(before);
    expect(sessions.for("bot-1").run).not.toBe(before);
  });

  test("it leaves the other Bots alone", () => {
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    const other = sessions.for("bot-2").run;
    sessions.for("bot-1");
    sessions.renewRun("bot-1");
    expect(sessions.for("bot-2").run).toBe(other);
  });

  test("resetting a Bot that has no session yet still gives it one", () => {
    // Reset is reachable before anything else has touched the Bot, and a handler that assumed a
    // session was already there would answer about one it had just silently created empty.
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    expect(sessions.renewRun("bot-1")).toBe("run-1");
  });

  test("the generation carries on, because the browser is what restarts it", () => {
    // Deliberately not reset here. The counter belongs to the browser, and `sessionFor` mints it at
    // zero for a session that is new; a renew that also zeroed it would make a fresh generation one
    // arrive under a fresh run, which is the pair the server has no way to order.
    const sessions = createSessions({
      isLive: () => true,
      mintRun: counting(),
    });
    const session = sessions.for("bot-1");
    session.snapshotId = 7;
    sessions.renewRun("bot-1");
    expect(sessions.for("bot-1").snapshotId).toBe(7);
  });
});
