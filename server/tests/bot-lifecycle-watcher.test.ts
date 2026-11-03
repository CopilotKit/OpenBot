import { afterEach, expect, test } from "bun:test";
import {
  BotPausedError,
  checkRunningTurnsForTests,
  configureBotLifecycle,
  guardBotTurn,
  type PauseReader,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";

/**
 * The pause watcher against pauses that can be unreadable on demand. A turn must not start while the
 * pause cannot be read, but one failed read in the five-second poll must not stop every turn a
 * replica is running for every person: only a pause, or pauses that stay unreadable, do.
 *
 * Unreadable both ways the real reader can be: it throws, or it cannot say yet (`undefined`, before
 * this instance has read people's preferences from Intelligence).
 */
function flakyPauses(failure: "throws" | "unknown" = "throws") {
  const state = { fail: false, pausedAt: null as Date | null };
  const pauses: PauseReader = {
    pausedAt() {
      if (state.fail) {
        if (failure === "throws")
          throw new Error("the preferences could not be read");
        return undefined;
      }
      return state.pausedAt;
    },
  };
  return { pauses, state };
}

afterEach(() => resetBotLifecycleForTests());

test("a turn does not start while the pause cannot be read", async () => {
  for (const failure of ["throws", "unknown"] as const) {
    const { pauses, state } = flakyPauses(failure);
    configureBotLifecycle({ pauses });
    state.fail = true;
    await expect(
      guardBotTurn({ ownerUserId: "ada", agentId: "bot" }),
    ).rejects.toBeInstanceOf(BotPausedError);
  }
});

test("one failed read in the watcher leaves running turns alone", async () => {
  const { pauses, state } = flakyPauses();
  configureBotLifecycle({ pauses });
  const ada = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  const grace = await guardBotTurn({ ownerUserId: "grace", agentId: "other" });

  state.fail = true;
  await checkRunningTurnsForTests();
  expect(ada.aborted).toBe(false);
  expect(grace.aborted).toBe(false);

  state.fail = false;
  await checkRunningTurnsForTests();
  state.fail = true;
  await checkRunningTurnsForTests();
  await checkRunningTurnsForTests();
  // A read that recovered in between starts the count again.
  expect(ada.aborted).toBe(false);
});

test("pauses that stay unreadable stop the turns, and a pause stops them at once", async () => {
  const { pauses, state } = flakyPauses();
  configureBotLifecycle({ pauses });
  const signal = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  state.fail = true;
  for (let check = 0; check < 3; check += 1) await checkRunningTurnsForTests();
  expect(signal.aborted).toBe(true);

  state.fail = false;
  const next = await guardBotTurn({ ownerUserId: "ada", agentId: "bot" });
  state.pausedAt = new Date();
  await checkRunningTurnsForTests();
  expect(next.aborted).toBe(true);
});
