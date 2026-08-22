import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { sweepAuditTrail } from "../src/audit-retention";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The audit trail has to be able to stop growing.
 *
 * Every click, keystroke, scroll, tool call, refusal, command and sign-in is a row, and nothing in
 * the product ever removed one. That is the largest table in the deployment within weeks of real
 * use, and it is also a control an enterprise buyer asks about directly: "what is your retention
 * policy" had no answer other than "everything, forever, and you cannot change it".
 *
 * Against a real database because the whole thing is SQL: the advisory lock that decides which
 * server sweeps, the batching, and the interval arithmetic.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

/** The id column is a uuid, so the rows are found by their target rather than by a marker in the id. */
const MARKER = "retention-test";

async function event(daysAgo: number, index: number): Promise<void> {
  await database.insert(auditEvents).values({
    eventType: "computer.action_allowed",
    targetType: MARKER,
    targetId: `${MARKER}-${index}`,
    payload: {},
    createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
}

async function remaining(): Promise<number> {
  const rows = await database
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.targetType, MARKER));
  return rows.length;
}

/*
 * Cleaning up has to obey the same rule as everything else.
 *
 * A plain delete is refused, which is the guarantee working: the trail is append-only and the
 * database enforces it. So the tests only ever create rows old enough for a one-day retention window
 * to remove, and clean up by declaring that window the way the sweep does.
 */
afterEach(async () => {
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('openbot.audit_retention_days', '1', true)`,
    );
    await tx.delete(auditEvents).where(eq(auditEvents.targetType, MARKER));
  });
});

/**
 * Whether a rejection was the append-only trigger.
 *
 * Drizzle wraps the Postgres error, so the outer message is "Failed query: ..." and the reason is on
 * the cause. Asserting only that it rejected would pass on a typo in the table name.
 */
async function refusedAsAppendOnly(
  work: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      if (
        String((current as { message?: string }).message ?? "").includes(
          "append-only",
        )
      ) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}

describe("keeping the audit trail to a retention policy", () => {
  test("removes what is older than the window and keeps the rest", async () => {
    await event(400, 1);
    await event(100, 2);
    await event(10, 3);
    await event(2, 4);

    const { deleted } = await sweepAuditTrail(databaseUrl, 90);

    expect(deleted).toBe(2);
    expect(await remaining()).toBe(2);
  });

  test("keeps everything when no policy is set", async () => {
    // The default, and the safe one. Deleting somebody's trail because a default said so is worse
    // than a table that grows, so an unset or nonsense window sweeps nothing at all.
    await event(400, 1);

    for (const window of [0, -1, Number.NaN]) {
      const { deleted } = await sweepAuditTrail(databaseUrl, window);
      expect(deleted).toBeNull();
    }
    expect(await remaining()).toBe(1);
  });

  test("the database refuses a malformed window even when the caller does not", async () => {
    // The test above stops in TypeScript: sweepAuditTrail returns before it opens a connection, so
    // it proves the caller's guard and says nothing about the trigger. The trigger has its own
    // branch for this and nothing exercised it, which is the shape where a guard reads as covered
    // and is not. These set the value the sweep would set and then delete directly.
    await event(400, 1);

    for (const window of ["0", "-1", "", "garbage"]) {
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('openbot.audit_retention_days', ${window}, true)`,
          );
          await tx.delete(auditEvents).where(eq(auditEvents.targetType, MARKER));
        }),
      );
    }
    expect(await remaining()).toBe(1);
  });

  test("the trail cannot be truncated away", async () => {
    // TRUNCATE does not fire row-level triggers, so audit_events_append_only never ran and the whole
    // trail went in one statement. The guard for it has to answer before the retention setting is
    // read: a statement trigger has no OLD row, so a version that reaches the window comparison
    // returns NULL there and permits the truncate. It refuses only while the setting is unset, which
    // is the case a happy-path test would pick.
    await event(400, 1);

    await refusedAsAppendOnly(() =>
      database.execute(sql`truncate table ${auditEvents}`),
    );
    expect(await remaining()).toBe(1);

    // The setting that makes a delete legal must not make a truncate legal.
    await refusedAsAppendOnly(() =>
      database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('openbot.audit_retention_days', '30', true)`,
        );
        await tx.execute(sql`truncate table ${auditEvents}`);
      }),
    );
    expect(await remaining()).toBe(1);
  });

  test("a row exactly inside the window survives", async () => {
    // The boundary. Off by a day here means a deployment promising 90 days keeps 89.
    await event(89, 1);

    await sweepAuditTrail(databaseUrl, 90);

    expect(await remaining()).toBe(1);
  });

  test("only one server sweeps at a time", async () => {
    /*
     * N servers running the same delete over the same rows every hour is N times the work for one
     * outcome, on the largest table in the deployment and the one every action writes to. The
     * advisory lock decides. A second sweep while one holds it reports null rather than zero, so a
     * caller can tell "somebody else is doing it" from "there was nothing to do".
     */
    await event(400, 1);

    /*
     * Its own connection, standing in for the other server. A session advisory lock belongs to one
     * connection and is re-entrant within it, so taking it through the shared pool would prove
     * nothing: the sweep might be handed the same connection and sail through.
     */
    const otherServer = postgres(databaseUrl, { max: 1 });
    try {
      const [lock] = await otherServer`
        select pg_try_advisory_lock(4192004) as held
      `;
      expect(lock?.held).toBe(true);

      const { deleted } = await sweepAuditTrail(databaseUrl, 90);
      expect(deleted).toBeNull();
      expect(await remaining()).toBe(1);
    } finally {
      await otherServer.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  test("a recent row cannot be deleted, whatever the window says", async () => {
    /*
     * The line retention must not cross. "We deleted the rows about the incident" has to stay
     * impossible, so the trigger refuses any row inside the declared window rather than trusting
     * the statement to only ask for old ones.
     */
    await event(2, 1);

    expect(
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('openbot.audit_retention_days', '3650', true)`,
          );
          await tx
            .delete(auditEvents)
            .where(eq(auditEvents.targetType, MARKER));
        }),
      ),
    ).toBe(true);

    expect(await remaining()).toBe(1);
  });

  test("a row can never be edited, under any setting", async () => {
    // Retention removes history; it does not rewrite it. An UPDATE is refused before the window is
    // even considered.
    await event(400, 1);

    expect(
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('openbot.audit_retention_days', '1', true)`,
          );
          await tx
            .update(auditEvents)
            .set({ payload: { tampered: true } })
            .where(eq(auditEvents.targetType, MARKER));
        }),
      ),
    ).toBe(true);
  });

  test("a plain delete with no policy declared is still refused", async () => {
    // What anybody reaching the table without going through the sweep gets, which is the case the
    // trigger exists for.
    await event(400, 1);

    expect(
      await refusedAsAppendOnly(async () => {
        await database
          .delete(auditEvents)
          .where(eq(auditEvents.targetType, MARKER));
      }),
    ).toBe(true);

    expect(await remaining()).toBe(1);
  });

  test("the lock is released, so the next sweep can run", async () => {
    // A sweep that kept the lock would be the last one this deployment ever ran.
    await event(400, 1);
    await sweepAuditTrail(databaseUrl, 90);

    await event(400, 2);
    const { deleted } = await sweepAuditTrail(databaseUrl, 90);

    expect(deleted).toBe(1);
  });
});
