import { describe, expect, test } from "bun:test";
import type { Screencast } from "../src/screencast";
import { createViewerSlot, SUPERSEDED } from "../src/viewer";

/**
 * Who owns the live screen, and what may act on it.
 *
 * A Bot has one live screen, and a second `/stream` replaces the first rather than being refused. The
 * replaced socket is not closed by that, so it stays open and closes whenever its client gets round
 * to it, which on an ordinary make-before-break reconnect is after the replacement is already
 * casting. Everything that goes wrong here goes wrong because something acted on the session's
 * viewer without establishing that it owned the one it was acting on.
 *
 * So ownership is the thing under test, and it is held per socket. A claim is taken before the
 * browser is asked for a page, which is what lets a close that lands during a cold launch be honored
 * at all: there is something to release even before there is a cast. Everything the launch produces
 * afterwards goes through that claim and is refused once it is revoked.
 *
 * The decisions rather than the stopping. Starting and stopping a cast is Playwright's job and is not
 * where the wrong answers were; `browser-eviction.ts` splits the same way and for the same reason.
 * These tests use fake casts, so nothing here needs Chrome.
 */

/** A cast that records what was asked of it. Enough of `Screencast` for every decision below. */
function fakeCast(): Screencast & { stops: number; sent: unknown[] } {
  const cast = {
    stops: 0,
    sent: [] as unknown[],
    async stop() {
      cast.stops += 1;
    },
    async send(message: unknown) {
      cast.sent.push(message);
    },
  };
  return cast as Screencast & { stops: number; sent: unknown[] };
}

/** A cast whose stop hangs until it is let go, so a teardown can be observed mid-flight. */
function pendingCast(): Screencast & { finish: () => void; stops: number } {
  let release = () => {};
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cast = {
    stops: 0,
    async stop() {
      cast.stops += 1;
      await stopped;
    },
    async send() {},
    finish: () => release(),
  };
  return cast as Screencast & { finish: () => void; stops: number };
}

/** A cast whose stop rejects. The teardown paths must survive one. */
function brokenCast(): Screencast {
  return {
    async stop() {
      throw new Error("the page went away first");
    },
    async send() {},
  } as Screencast;
}

function recorder() {
  const said: string[] = [];
  return { said, notify: (reason: string) => said.push(reason) };
}

describe("taking the live screen", () => {
  test("a claim owns the screen before any cast exists", async () => {
    // The whole point of claiming before the browser is asked for a page. Until this, a close during
    // a cold launch found nothing to release and the launch installed a cast for a socket that had
    // already gone.
    const slot = createViewerSlot();
    const socket = { id: "a" };

    slot.claim(socket, () => {});

    expect(slot.occupied()).toBe(true);
    expect(slot.standingOf(socket).state).toBe("starting");
  });

  test("installing a cast makes that socket the one casting", async () => {
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const cast = fakeCast();

    const claim = slot.claim(socket, () => {});
    expect(await claim.install(cast)).toBe(true);

    const standing = slot.standingOf(socket);
    expect(standing.state).toBe("casting");
    expect(standing.state === "casting" && standing.cast).toBe(cast);
  });

  test("a socket that never claimed owns nothing", () => {
    const slot = createViewerSlot();

    expect(slot.standingOf({ id: "nobody" }).state).toBe("gone");
    expect(slot.occupied()).toBe(false);
  });

  test("identity, not shape, when asked what a socket owns", async () => {
    // Two sockets are never equal by value, and comparing them that way would hand the screen to any
    // socket that happened to look like the owner.
    const slot = createViewerSlot();
    const claim = slot.claim({ id: "a" }, () => {});
    await claim.install(fakeCast());

    expect(slot.standingOf({ id: "a" }).state).toBe("gone");
  });

  test("identity, not shape, when a socket gives the screen up", async () => {
    // The same rule on the release path, and it needs two sockets that look alike to catch: a
    // comparison by value would let a stranger's close stop the owner's cast, which is the original
    // bug wearing different clothes. Distinct objects, deliberately identical contents.
    const slot = createViewerSlot();
    const owner = { id: "same" };
    const twin = { id: "same" };
    const cast = fakeCast();
    const claim = slot.claim(owner, () => {});
    await claim.install(cast);

    await slot.release(twin);

    expect(cast.stops).toBe(0);
    expect(slot.standingOf(owner).state).toBe("casting");
  });
});

describe("a close that lands while the browser is still starting", () => {
  test("the cast the launch produces is refused and stopped, not installed", async () => {
    // Failure 1. `open` awaits a page, which launches Chromium when nothing is running, and a socket
    // that closes inside that window used to leave a cast and a 1Hz interval behind for a socket that
    // was already gone. Nothing arrived later to stop them, and the interval went on relaunching the
    // browser after somebody stopped it.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});

    await slot.release(socket);

    const late = fakeCast();
    expect(await claim.install(late)).toBe(false);
    // Refused and stopped by the slot, so a caller cannot leak a cast by forgetting to.
    expect(late.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
    expect(slot.standingOf(socket).state).toBe("gone");
  });

  test("a follow loop registered after the close is refused", async () => {
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});

    await slot.release(socket);

    expect(claim.setFollow(() => {})).toBe(false);
  });

  test("the claim is released even when the launch threw", async () => {
    // `open`'s catch closes the socket after sending an error frame. If nothing released the claim
    // there, the slot would stay occupied forever and `forgetIdleSessions` could never sweep the
    // session, which is the unbounded growth it exists to stop.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    slot.claim(socket, () => {});

    await slot.release(socket);

    expect(slot.occupied()).toBe(false);
  });

  test("releasing the same socket twice is harmless", async () => {
    // The catch path closes the socket, so `close` runs release a second time for the same socket.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});
    const cast = fakeCast();
    await claim.install(cast);

    await slot.release(socket);
    await slot.release(socket);

    expect(cast.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
  });

  test("a socket closing its own screen is not told about it", async () => {
    // Only supersession and the browser going away are news. A client that closed its own socket
    // already knows, and the socket is on its way out anyway, so telling it is at best a write to
    // something that is gone.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const heard = recorder();
    const claim = slot.claim(socket, heard.notify);
    await claim.install(fakeCast());

    await slot.release(socket);

    expect(heard.said).toEqual([]);
  });

  test("releasing a socket that owns nothing leaves the owner alone", async () => {
    // The superseded socket's close, arriving after its replacement is already casting. Stopping the
    // session's viewer without asking who owns it is what made the reconnected screen go quiet.
    const slot = createViewerSlot();
    const owner = { id: "owner" };
    const stranger = { id: "stranger" };
    const cast = fakeCast();
    const claim = slot.claim(owner, () => {});
    await claim.install(cast);

    await slot.release(stranger);

    expect(cast.stops).toBe(0);
    expect(slot.standingOf(owner).state).toBe("casting");
    expect(slot.occupied()).toBe(true);
  });
});

describe("a second connection taking over", () => {
  test("the replaced cast and its follow loop are torn down", async () => {
    const slot = createViewerSlot();
    const first = { id: "first" };
    const firstCast = fakeCast();
    let cancelled = 0;

    const firstClaim = slot.claim(first, () => {});
    await firstClaim.install(firstCast);
    firstClaim.setFollow(() => {
      cancelled += 1;
    });

    slot.claim({ id: "second" }, () => {});
    await slot.settled();

    expect(firstCast.stops).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("the replaced socket is told, and is not closed by us", async () => {
    // The socket belongs to a client that may still be using it, so replacement does not close it.
    // Telling it is the whole reason the notify callback exists: otherwise its screen freezes on the
    // last frame and its input goes nowhere without a word.
    const slot = createViewerSlot();
    const heard = recorder();

    const firstClaim = slot.claim({ id: "first" }, heard.notify);
    await firstClaim.install(fakeCast());

    slot.claim({ id: "second" }, () => {});
    await slot.settled();

    // The exact message, not merely that something was said. This is the only thing a replaced
    // viewer is ever told, and "some non-empty string" stays green if it becomes the stop message,
    // the no-longer-live message, or a stray debug line.
    expect(heard.said).toEqual([SUPERSEDED]);
  });

  test("the replaced claim can no longer install or follow", async () => {
    // Failure 4, as the rule that removes it rather than as an observation of it. Two opens that
    // interleave used to let the older one assign itself over the newer one after its awaits, leaving
    // an interval nothing held. This is the module's rule under test, not the running process.
    const slot = createViewerSlot();
    const firstClaim = slot.claim({ id: "first" }, () => {});

    slot.claim({ id: "second" }, () => {});
    await slot.settled();

    const late = fakeCast();
    expect(await firstClaim.install(late)).toBe(false);
    expect(late.stops).toBe(1);
    expect(firstClaim.setFollow(() => {})).toBe(false);
  });

  test("the new socket is the one casting afterwards", async () => {
    const slot = createViewerSlot();
    const second = { id: "second" };
    const secondCast = fakeCast();

    const firstClaim = slot.claim({ id: "first" }, () => {});
    await firstClaim.install(fakeCast());

    const secondClaim = slot.claim(second, () => {});
    await secondClaim.install(secondCast);
    await slot.settled();

    const standing = slot.standingOf(second);
    expect(standing.state).toBe("casting");
    expect(standing.state === "casting" && standing.cast).toBe(secondCast);
  });
});

describe("following the page the Bot moves to", () => {
  test("a replacement cast supersedes the one before it", async () => {
    // The 1Hz loop re-attaches when the Bot opens a different page. The new cast has to be running
    // before the old one stops, or the screen blanks between the two.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const first = fakeCast();
    const second = fakeCast();

    const claim = slot.claim(socket, () => {});
    await claim.install(first);
    await claim.install(second);

    expect(first.stops).toBe(1);
    expect(second.stops).toBe(0);
    const standing = slot.standingOf(socket);
    expect(standing.state === "casting" && standing.cast).toBe(second);
  });

  test("replacing the follow loop cancels the one it replaces", async () => {
    const slot = createViewerSlot();
    let firstCancelled = 0;
    const claim = slot.claim({ id: "a" }, () => {});
    await claim.install(fakeCast());

    claim.setFollow(() => {
      firstCancelled += 1;
    });
    claim.setFollow(() => {});

    expect(firstCancelled).toBe(1);
  });
});

describe("accounting for a cast the slot refused", () => {
  test("a refused cast is stopped before the slot reports itself settled", async () => {
    // Occupancy and `settled` are how the sweep and the tests learn that nothing is casting. A cast
    // stopped outside that accounting lets both answer "nothing" while Chrome is still encoding, so
    // the refusal has to be part of the teardown rather than beside it.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});
    await slot.release(socket);

    const late = pendingCast();
    const refusal = claim.install(late);

    expect(slot.occupied()).toBe(true);

    late.finish();
    expect(await refusal).toBe(false);
    await slot.settled();

    expect(slot.occupied()).toBe(false);
  });
});

describe("the browser closing under the viewer", () => {
  test("everything is torn down and the watcher is told", async () => {
    // Failure 2 and the eviction paths behind it. A browser that closes while a viewer is alive gets
    // relaunched a second later by the follow tick, so a stopped computer restarts itself and an
    // idle one never goes away.
    const slot = createViewerSlot();
    const heard = recorder();
    const cast = fakeCast();
    let cancelled = 0;

    const claim = slot.claim({ id: "a" }, heard.notify);
    await claim.install(cast);
    claim.setFollow(() => {
      cancelled += 1;
    });

    await slot.releaseAll("the computer was stopped");

    expect(cast.stops).toBe(1);
    expect(cancelled).toBe(1);
    expect(heard.said).toEqual(["the computer was stopped"]);
    expect(slot.occupied()).toBe(false);
  });

  test("a viewer still starting is torn down too", async () => {
    // The claim exists before the cast does, and a browser that closes inside that window has to
    // revoke it, or the launch still in flight installs a cast onto a browser that is gone.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});

    await slot.releaseAll("the computer was stopped");

    const late = fakeCast();
    expect(await claim.install(late)).toBe(false);
    expect(late.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
  });

  test("releasing an empty slot tells nobody and does nothing", async () => {
    const slot = createViewerSlot();

    await slot.releaseAll("the computer was stopped");

    expect(slot.occupied()).toBe(false);
  });
});

describe("what a socket may do with the screen right now", () => {
  test("the casting socket is handed its own cast", async () => {
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const cast = fakeCast();
    const claim = slot.claim(socket, () => {});
    await claim.install(cast);

    const standing = slot.standingOf(socket);

    expect(standing.state === "casting" && standing.cast).toBe(cast);
  });

  test("a socket whose screen is still starting is told apart from one that is gone", async () => {
    // Both own no cast, and answering them the same way tells somebody whose screen is still opening
    // that their session ended. The message is the only thing they get, so it has to be the true one.
    const slot = createViewerSlot();
    const starting = { id: "starting" };
    const gone = { id: "gone" };
    slot.claim(starting, () => {});

    expect(slot.standingOf(starting).state).toBe("starting");
    expect(slot.standingOf(gone).state).toBe("gone");
  });

  test("a superseded socket is gone, not starting", async () => {
    const slot = createViewerSlot();
    const first = { id: "first" };
    slot.claim(first, () => {});

    slot.claim({ id: "second" }, () => {});
    await slot.settled();

    expect(slot.standingOf(first).state).toBe("gone");
  });
});

describe("the session sweep asking whether anybody is watching", () => {
  test("a Bot is watched from the claim, not from the first frame", async () => {
    // `forgetIdleSessions` drops sessions with nobody watching and no live browser. Reading occupancy
    // from an installed cast would call a Bot unwatched for the whole cold launch, and sweeping then
    // would drop the control state out from under the person who is about to be watching it.
    const slot = createViewerSlot();
    slot.claim({ id: "a" }, () => {});

    expect(slot.occupied()).toBe(true);
  });

  test("a Bot stays watched until teardown has finished", async () => {
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});
    await claim.install(fakeCast());

    const releasing = slot.release(socket);
    await releasing;

    expect(slot.occupied()).toBe(false);
  });

  test("a Bot is still watched while its cast is stopping", async () => {
    // Occupancy has to count the teardown itself, not just whether somebody holds the slot. The
    // sweep drops sessions with nobody watching and no live browser, and a session dropped while its
    // cast is still stopping takes the control state with it.
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const cast = pendingCast();
    const claim = slot.claim(socket, () => {});
    await claim.install(cast);

    const releasing = slot.release(socket);
    await Promise.resolve();

    expect(slot.occupied()).toBe(true);

    cast.finish();
    await releasing;

    expect(slot.occupied()).toBe(false);
  });

  test("a claim taken while a teardown is in flight keeps the Bot watched", async () => {
    // The reconnect that arrives before the old cast has finished stopping. Clearing occupancy when
    // the older teardown completes would report nobody watching while somebody is.
    const slot = createViewerSlot();
    const first = { id: "first" };
    const claim = slot.claim(first, () => {});
    await claim.install(fakeCast());

    const releasing = slot.release(first);
    slot.claim({ id: "second" }, () => {});
    await releasing;

    expect(slot.occupied()).toBe(true);
  });
});

describe("a cast that cannot be stopped", () => {
  test("a rejecting stop does not break a takeover", async () => {
    // The page can go away before the cast is told to stop. `attach` already swallows this; teardown
    // has to as well, or one dead page leaves the slot wedged for every later connection.
    const slot = createViewerSlot();
    const firstClaim = slot.claim({ id: "first" }, () => {});
    await firstClaim.install(brokenCast());

    slot.claim({ id: "second" }, () => {});
    await slot.settled();

    expect(slot.standingOf({ id: "first" }).state).toBe("gone");
  });

  test("a rejecting stop does not break releasing the browser", async () => {
    const slot = createViewerSlot();
    const socket = { id: "a" };
    const claim = slot.claim(socket, () => {});
    await claim.install(brokenCast());

    await slot.releaseAll("the computer was stopped");

    expect(slot.occupied()).toBe(false);
  });

  test("a notify that throws does not stop the teardown", async () => {
    // The socket may already be gone when we try to tell it. Sending is best effort; the teardown is
    // not.
    const slot = createViewerSlot();
    const cast = fakeCast();
    const claim = slot.claim({ id: "a" }, () => {
      throw new Error("that socket is closed");
    });
    await claim.install(cast);

    await slot.releaseAll("the computer was stopped");

    expect(cast.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
  });
});
