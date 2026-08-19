import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, auditEvents, routineRuns, users } from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { hashWebhookSecret } from "../src/routines/webhooks";
import { TEST_POOL } from "./support/database";

/**
 * What the storage has to guarantee, against a real database.
 *
 * Three of these cannot be tested any other way, because the guarantee is the database's:
 *
 *  - one live run per routine, which is a unique index rather than a check in the scheduler, so a
 *    second claim has to LOSE rather than race
 *  - a routine deleted mid-run takes its runs with it, and the finishing write afterwards is a
 *    no-op rather than a crash
 *  - a missed window is stamped with the window's own time, which is what stops the same miss being
 *    recorded once a minute until the next one comes round
 *
 * The rest is ownership: somebody else's routine is not readable, not editable and not deletable,
 * and the scoping is in the query rather than applied afterwards.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_routine_${suite}`;
const ownerId = `user_routine_owner_${suite}`;
const strangerId = `user_routine_stranger_${suite}`;

const store = createRoutineStore(database, createAuditStore(database));
const owner = { id: ownerId, userId: ownerId };

const dailySchedule = {
  type: "daily" as const,
  time: "08:00",
  weekdays: [1, 2, 3, 4, 5],
};

async function makeRoutine(name = "Overnight alerts") {
  return store.create(
    {
      agentId: botId,
      ownerUserId: ownerId,
      name,
      prompt: "Check the overnight alerts and write me a summary.",
      schedule: dailySchedule,
    },
    owner,
  );
}

beforeAll(async () => {
  for (const id of [ownerId, strangerId]) {
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id })
      .onConflictDoNothing();
  }
  await database
    .insert(agents)
    .values({
      id: botId,
      name: "Risk analyst",
      type: "built_in",
      configuration: { systemPrompt: "You are a risk analyst." },
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // The agent and the users cascade to everything this file made, so removing them is enough.
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(inArray(users.id, [ownerId, strangerId]));
});

describe("keeping routines", () => {
  test("a created routine comes back with its schedule and its next due time", async () => {
    const routine = await makeRoutine();
    expect(routine.schedule).toEqual(dailySchedule);
    expect(routine.enabled).toBe(true);
    // Computed on read. A stored next-due is wrong the moment somebody edits the schedule.
    expect(routine.nextDueAt).not.toBeNull();
    expect(routine.lastRun).toBeNull();

    await store.remove(routine.id, ownerId, owner);
  });

  test("a disabled routine has no next due time, because nothing will fire", async () => {
    const routine = await makeRoutine();
    const updated = await store.update(
      routine.id,
      ownerId,
      { enabled: false },
      owner,
    );
    expect(updated?.nextDueAt).toBeNull();

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * The scoping is in the query, not applied after it. A routine carries a prompt somebody wrote
   * about their own work, and "we fetched it and then decided not to show it" is the shape most
   * accidental disclosures take.
   */
  test("somebody else's routine is not readable, editable or deletable", async () => {
    const routine = await makeRoutine("Private morning check");

    expect(await store.get(routine.id, strangerId)).toBeNull();
    expect(
      await store.update(routine.id, strangerId, { name: "Mine now" }, owner),
    ).toBeNull();
    expect(await store.remove(routine.id, strangerId, owner)).toBe(false);
    // Still there, and still saying what its owner wrote.
    expect((await store.get(routine.id, ownerId))?.name).toBe(
      "Private morning check",
    );
    expect(await store.list(strangerId)).toEqual([]);

    await store.remove(routine.id, ownerId, owner);
  });

  test("creating, changing and deleting a routine each leave a row, and none carries the prompt", async () => {
    const routine = await makeRoutine("Audited routine");
    await store.update(routine.id, ownerId, { name: "Renamed" }, owner);
    await store.remove(routine.id, ownerId, owner);

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "routine"),
          eq(auditEvents.targetId, routine.id),
        ),
      );
    expect(rows.map((row) => row.eventType).sort()).toEqual([
      "routine.created",
      "routine.deleted",
      "routine.updated",
    ]);
    // The instruction a person wrote about their own work is not in the trail. It can name
    // customers, systems and amounts, and the name, the Bot and the schedule are what a reader needs.
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain("overnight alerts");
    }
  });
});

describe("claiming a run", () => {
  test("the second claim loses rather than starting a second run", async () => {
    const routine = await makeRoutine();

    const first = await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      actor: owner,
    });
    // Two ticks overlapping is ordinary. What must not happen is two emails sent.
    const second = await store.startRun({
      routineId: routine.id,
      trigger: "manual",
      threadId: "thread-b",
      actor: owner,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await store.remove(routine.id, ownerId, owner);
  });

  test("a finished run frees the routine for the next one", async () => {
    const routine = await makeRoutine();
    const first = await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      actor: owner,
    });
    await store.finishRun({
      runId: first?.id as string,
      routineId: routine.id,
      status: "completed",
      summary: "Nothing overnight.",
      actor: owner,
    });

    const second = await store.startRun({
      routineId: routine.id,
      trigger: "manual",
      threadId: "thread-b",
      actor: owner,
    });
    expect(second).not.toBeNull();

    const history = await store.runs(routine.id);
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.summary).toBe("Nothing overnight.");

    await store.remove(routine.id, ownerId, owner);
  });

  test("a failed run is recorded as failed, with the reason", async () => {
    const routine = await makeRoutine();
    const run = await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      actor: owner,
    });
    await store.finishRun({
      runId: run?.id as string,
      routineId: routine.id,
      status: "failed",
      error: "The model is unreachable.",
      actor: owner,
    });

    const [recorded] = await store.runs(routine.id);
    expect(recorded?.status).toBe("failed");
    expect(recorded?.error).toBe("The model is unreachable.");

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "routine"),
          eq(auditEvents.targetId, routine.id),
          eq(auditEvents.eventType, "routine.run_failed"),
        ),
      );
    expect(rows).toHaveLength(1);

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * The row nothing else in the store can clear: the process that owned the run died between
   * claiming it and finishing it. It holds the one-live-run index, so the routine never fires again
   * by any route at all, and the only cure without this is deleting the routine and its history.
   */
  test("a run left behind by a process that stopped is closed out, and the routine can run again", async () => {
    const routine = await makeRoutine();
    const abandoned = await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      // Claimed an hour and a half ago, by a process that is no longer here to finish it.
      startedAt: new Date(Date.now() - 90 * 60_000),
      actor: owner,
    });
    expect(
      await store.startRun({
        routineId: routine.id,
        trigger: "manual",
        threadId: "thread-b",
        actor: owner,
      }),
    ).toBeNull();

    const reaped = await store.reapStaleRuns({
      startedBefore: new Date(Date.now() - 60 * 60_000),
      actor: { id: "scheduler" },
    });
    expect(reaped).toBeGreaterThanOrEqual(1);

    const [closed] = await store.runs(routine.id);
    expect(closed?.id).toBe(abandoned?.id as string);
    expect(closed?.status).toBe("failed");
    // Says what is actually known, which is that how it ended is not known. A row that vanished
    // would leave the person reading the history believing nothing had been started, and it was.
    expect(closed?.error).toContain("stopped while the run was going");

    expect(
      await store.startRun({
        routineId: routine.id,
        trigger: "manual",
        threadId: "thread-c",
        actor: owner,
      }),
    ).not.toBeNull();

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * The routines page refetches every fifteen seconds while it is open, and a daily routine's
   * history grows by one row a day forever. What it needs is the newest run of each, which the
   * database returns; reading the whole history to find it is a page that gets slower every week.
   */
  test("the list carries the newest run of each routine, and only that one", async () => {
    const routine = await makeRoutine();
    for (const [index, summary] of ["older", "newer"].entries()) {
      const run = await store.startRun({
        routineId: routine.id,
        trigger: "schedule",
        threadId: `thread-${index}`,
        startedAt: new Date(Date.now() - (10 - index) * 60_000),
        actor: owner,
      });
      await store.finishRun({
        runId: run?.id as string,
        routineId: routine.id,
        status: "completed",
        summary,
        actor: owner,
      });
    }

    const listed = (await store.list(ownerId)).find(
      (entry) => entry.id === routine.id,
    );
    expect(listed?.lastRun?.summary).toBe("newer");

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * A person deleting a routine has asked for it to be gone. The runner finishing a moment later
   * must not turn that into an unhandled failure, and the run rows must not outlive the thing they
   * were runs of.
   */
  test("a routine deleted mid-run takes its runs with it, and finishing is a no-op", async () => {
    const routine = await makeRoutine();
    const run = await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      actor: owner,
    });

    await store.remove(routine.id, ownerId, owner);

    await store.finishRun({
      runId: run?.id as string,
      routineId: routine.id,
      status: "completed",
      summary: "Finished after the routine was deleted.",
      actor: owner,
    });

    const orphans = await database
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, run?.id as string));
    expect(orphans).toEqual([]);
  });
});

describe("a window nobody was awake for", () => {
  test("is stamped with its own time, so the next tick does not record it again", async () => {
    const routine = await makeRoutine();
    const dueAt = new Date("2026-08-13T08:00:00.000Z");

    await store.recordMissed({ routineId: routine.id, dueAt, actor: owner });

    const [missed] = await store.runs(routine.id);
    expect(missed?.status).toBe("missed");
    // Not `now`. Stamping it with the window is what makes recording a miss idempotent: the
    // scheduler then sees a run at or after the window and decides there is nothing to do.
    expect(missed?.startedAt).toBe(dueAt.toISOString());

    const [candidate] = (await store.dueCandidates()).filter(
      (entry) => entry.id === routine.id,
    );
    expect(candidate?.lastRunAt?.toISOString()).toBe(dueAt.toISOString());
    expect(candidate?.activeRun).toBe(false);

    await store.remove(routine.id, ownerId, owner);
  });

  test("a disabled routine is not offered to the scheduler at all", async () => {
    const routine = await makeRoutine();
    await store.update(routine.id, ownerId, { enabled: false }, owner);

    const offered = (await store.dueCandidates()).map((entry) => entry.id);
    expect(offered).not.toContain(routine.id);

    await store.remove(routine.id, ownerId, owner);
  });

  test("a run in flight is reported as such, so the tick skips it", async () => {
    const routine = await makeRoutine();
    await store.startRun({
      routineId: routine.id,
      trigger: "schedule",
      threadId: "thread-a",
      actor: owner,
    });

    const [candidate] = (await store.dueCandidates()).filter(
      (entry) => entry.id === routine.id,
    );
    expect(candidate?.activeRun).toBe(true);

    await store.remove(routine.id, ownerId, owner);
  });
});

describe("webhook triggers", () => {
  test("the secret is returned once and is not on the record afterwards", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );

    expect(created.secret).toBeTruthy();
    expect(JSON.stringify(created.trigger)).not.toContain(created.secret);
    expect(created.trigger.verificationPending).toBe(true);

    // The lookup the receiver uses carries the hash and only the hash.
    const found = await store.triggerByEndpoint(created.trigger.endpointId);
    expect(found?.secretHash).toBe(hashWebhookSecret(created.secret));

    const listed = await store.listTriggers();
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    await store.remove(routine.id, ownerId, owner);
  });

  test("rotating replaces the secret, and the old one stops matching", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );
    const rotated = await store.rotateTriggerSecret(created.trigger.id, owner);

    expect(rotated?.secret).not.toBe(created.secret);
    const found = await store.triggerByEndpoint(created.trigger.endpointId);
    // No overlap window. Somebody rotates because they think the old secret leaked, and a grace
    // period is a grace period for whoever has it.
    expect(found?.secretHash).not.toBe(hashWebhookSecret(created.secret));
    expect(found?.secretHash).toBe(
      hashWebhookSecret(rotated?.secret as string),
    );

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * The gate that catches a hook pointed at the wrong trigger. Confirming a trigger nothing has ever
   * called confirms nothing, so it is refused rather than allowed as a formality.
   */
  test("a trigger cannot be confirmed until a delivery has actually arrived", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );

    expect(await store.verifyTrigger(created.trigger.id, owner)).toBeNull();

    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "build.finished", branch: "main" },
      captureSample: true,
    });

    const verified = await store.verifyTrigger(created.trigger.id, owner);
    expect(verified?.verificationPending).toBe(false);
    expect(verified?.verifiedAt).not.toBeNull();
    expect(verified?.sample).toEqual({
      event: "build.finished",
      branch: "main",
    });
    expect(verified?.deliveryCount).toBe(1);

    await store.remove(routine.id, ownerId, owner);
  });

  test("later deliveries are counted and do not overwrite the sample", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );
    /*
     * Both deliveries ask for the sample, which is what the receiver actually does: the decision is
     * "capture" for every delivery that arrives while verification is pending, and a CI system given
     * the secret starts posting every minute. What must not happen is the person reading sample A on
     * the page and confirming sample B.
     */
    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "first" },
      captureSample: true,
    });
    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "second" },
      captureSample: true,
    });

    const beforeConfirming = (await store.listTriggers()).find(
      (entry) => entry.id === created.trigger.id,
    );
    expect(beforeConfirming?.sample).toEqual({ event: "first" });

    await store.verifyTrigger(created.trigger.id, owner);
    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "third" },
      captureSample: false,
    });

    const listed = (await store.listTriggers()).find(
      (entry) => entry.id === created.trigger.id,
    );
    expect(listed?.deliveryCount).toBe(3);
    // A trigger in use must not accumulate somebody else's payloads in this deployment's database.
    expect(listed?.sample).toEqual({ event: "first" });

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * Not scoped to whoever created it, unlike everything about a routine. A trigger is a URL on the
   * public internet, the page that lists them is the administrators' one, and an administrator who
   * could only shut the doors they personally opened could not answer the question they came to the
   * page with. The routes are what keep this away from everybody else; see routines/routes.ts.
   */
  test("a trigger somebody else created can still be listed, confirmed and shut off", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );
    const other = { id: strangerId, userId: strangerId };

    expect(
      (await store.listTriggers()).some(
        (entry) => entry.id === created.trigger.id,
      ),
    ).toBe(true);

    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "build.finished" },
      captureSample: true,
    });
    expect(
      (await store.verifyTrigger(created.trigger.id, other))
        ?.verificationPending,
    ).toBe(false);
    expect(
      (await store.updateTrigger(created.trigger.id, { enabled: false }, other))
        ?.enabled,
    ).toBe(false);
    expect(await store.deleteTrigger(created.trigger.id, other)).toBe(true);

    await store.remove(routine.id, ownerId, owner);
  });

  /*
   * Confirming a trigger is the moment an inert endpoint starts setting a Bot working, and turning
   * one off or deleting it are the moments a door closes. An administrator asking why deliveries
   * stopped last Tuesday is owed an answer other than silence.
   */
  test("confirming, changing and deleting a trigger each leave a row", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );
    await store.recordDelivery({
      id: created.trigger.id,
      body: { event: "build.finished" },
      captureSample: true,
    });
    // Its own event, not a refusal: this delivery had the right secret and was kept on purpose.
    await store.recordDeliveryEvent({
      endpointId: created.trigger.endpointId,
      triggerId: created.trigger.id,
      outcome: "captured",
      reason: "The first delivery to a new trigger is kept as a sample.",
      eventType: "build.finished",
    });
    await store.verifyTrigger(created.trigger.id, owner);
    await store.updateTrigger(created.trigger.id, { enabled: false }, owner);
    await store.deleteTrigger(created.trigger.id, owner);

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "webhook_trigger"),
          eq(auditEvents.targetId, created.trigger.id),
        ),
      );
    expect(rows.map((row) => row.eventType).sort()).toEqual([
      "webhook.captured",
      "webhook.trigger_created",
      "webhook.trigger_deleted",
      "webhook.trigger_updated",
      "webhook.trigger_verified",
    ]);
    // The secret is in none of them. A trail that could hand somebody the key is a trail that has
    // to be guarded as closely as the endpoint.
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain(created.secret);
    }

    await store.remove(routine.id, ownerId, owner);
  });

  test("deleting a routine takes its triggers with it", async () => {
    const routine = await makeRoutine();
    const created = await store.createTrigger(
      { name: "Build finished", ownerUserId: ownerId, routineId: routine.id },
      owner,
    );

    await store.remove(routine.id, ownerId, owner);

    // A door that opens onto nothing is worse than a closed one: the sender is told the delivery was
    // accepted and no work ever happens.
    expect(
      await store.triggerByEndpoint(created.trigger.endpointId),
    ).toBeNull();
  });
});
