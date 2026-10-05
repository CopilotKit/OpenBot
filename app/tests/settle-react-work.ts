import { act } from "react";

/**
 * DRAIN REACT BEFORE TAKING THE DOCUMENT AWAY.
 *
 * Every React test file here registers happy-dom in `beforeAll` and unregisters it in `afterAll`,
 * because bun walks every test file into one process and a document another file tore down mid-run
 * fails invisibly. `cleanup` in `afterEach` unmounts what a test rendered — but unmounting does not
 * retract a callback React's scheduler has ALREADY posted. If one is still posted when `afterAll`
 * runs `GlobalRegistrator.unregister()`, it fires against a `document` that no longer exists, and
 * bun reports it as `# Unhandled error between tests`: zero failing tests, a non-zero exit, and a
 * stack in `scheduler.development.js` carrying the name of whichever file bun happened to reach
 * next. Await this first and the queue is empty before the document goes away.
 *
 * WHY `act` AND NOT A `setTimeout`. Both halves of that question have a mechanical answer.
 *
 * First, the primitive. `scheduler` posts its host callback with `setImmediate` when one exists and
 * only falls back to `MessageChannel` when it does not (see the branch at the foot of
 * `scheduler.development.js`), and bun defines `setImmediate` — so in this runtime the pending work
 * is an immediate, not a message. `setImmediate` callbacks run in the order they were registered,
 * so a yield that is itself an immediate is ordered strictly AFTER every immediate already posted.
 * A `setTimeout(0)` is a different queue and carries no such ordering against a pending immediate:
 * it usually lands after, which is exactly the kind of "usually" that only fails on CI. React's
 * `act` yields through its own `enqueueTask`, which resolves to `module.require("timers")
 * .setImmediate` — the same primitive the scheduler posts on, so the ordering is by construction.
 *
 * Second, the number of turns. One turn is not enough no matter which primitive it uses, because
 * the work that runs during a turn can schedule more: a settling upload resolves on a microtask
 * after our yield was already queued, and the render it triggers is posted BEHIND us. What is
 * needed is a fixed point, not a fixed count — and that is precisely what `act` computes. While an
 * act scope is open React routes every newly scheduled callback into the act queue instead of the
 * scheduler, and `recursivelyFlushAsyncActWork` alternates flushing that queue with yielding a
 * macrotask until a yield comes back with the queue still empty. So the loop ends when React has
 * nothing left rather than after some count somebody guessed. `flushActQueue` also runs each
 * callback's continuation to completion, so work the scheduler would have sliced across several
 * 5ms budgets finishes inside one flush.
 *
 * The one thing this cannot reach is a render that was ALREADY sliced by the scheduler before the
 * drain opened: that continuation is re-posted by the scheduler rather than into the act queue.
 * Reaching that needs a single render to exceed the scheduler's 5ms budget, which a tree of a few
 * dozen nodes does not do — and a test that did would be telling us something worth hearing anyway.
 *
 * `act` needs `IS_REACT_ACT_ENVIRONMENT`, which `@testing-library/react` sets when it is imported;
 * every caller of this renders through it, so the flag is on by the time `afterAll` runs.
 */
export async function settleReactWork(): Promise<void> {
  await act(async () => {});
}
