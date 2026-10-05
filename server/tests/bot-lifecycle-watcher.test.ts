import { afterEach, expect, test } from "bun:test";
import {
  BotPausedError,
  checkRunningTurnsForTests,
  configureBotLifecycle,
  guardBotTurn,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import type { Database } from "../src/db/client";

/**
 * The pause watcher against a database that can fail on demand. A turn must not start while the
 * pause cannot be read, but one failed read in the five-second poll must not stop every turn a
 * replica is running for every person: only a pause, or a database that stays unreadable, does.
 */
function flakyDatabase() {
  const state = { fail: false, pausedAt: null as Date | null };
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => {
      if (state.fail) throw new Error("connection terminated unexpectedly");
      return [{ pausedAt: state.pausedAt }];
    },
  };
  const database = { select: () => query } as unknown as Database;
  return { database, state };
}

afterEach(() => resetBotLifecycleForTests());

test("a turn does not start while the pause cannot be read", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
  state.fail = true;
  await expect(
    guardBotTurn({ ownerUserId: "ada", agentId: "bot" }),
  ).rejects.toBeInstanceOf(BotPausedError);
});

test("one failed read in the watcher leaves running turns alone", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
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

test("a database that stays unreadable stops the turns, and a pause stops them at once", async () => {
  const { database, state } = flakyDatabase();
  configureBotLifecycle({ database });
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
