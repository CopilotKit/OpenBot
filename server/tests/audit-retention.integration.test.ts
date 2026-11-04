import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ACTION_RECORD_RETENTION_DAYS } from "../src/admin/controls";
import type { AuditTrailClient } from "../src/audit-trail/client";
import { syncAuditRetention } from "../src/audit-trail/retention";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { useTestAuditTrail } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The audit trail has to be able to stop growing.
 *
 * Every click, keystroke, scroll, tool call, refusal, command and sign-in is a row, and nothing in
 * the product ever removed one. That is the largest table in the deployment within weeks of real
 * use, and it is also a control an enterprise buyer asks about directly: "what is your retention
 * policy" had no answer other than "everything, forever, and you cannot change it".
 *
 * THE TRAIL LIVES IN INTELLIGENCE NOW, and so does its sweep. This deployment's part is saying the
 * window (`AUDIT_RETENTION_DAYS`, and Action Recording's 90 days) at boot, which the first half of
 * this file holds it to. The sweep itself, which used to be tested here (only rows older than the
 * window, nothing when no window is set, a row one day inside the window survives, one server at a
 * time under an advisory lock, the lock released for the next sweep), is Intelligence's, held to the
 * same rules in its `libs/audit-trail/src/audit-trail.pg.spec.ts`.
 *
 * The second half is the local `audit_events` table, kept unwritten for one release so an upgrading
 * deployment's earlier trail can be copied into Intelligence. It stays append-only exactly as it was,
 * against a real database because the whole thing is SQL.
 */

const databaseUrl = testDatabaseUrl();
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

describe("saying the retention window to Intelligence, which keeps the trail", () => {
  /** Leave the shared project keeping everything, as a deployment that never set a window does. */
  async function keepEverything() {
    await syncAuditRetention(useTestAuditTrail().client, {
      eventRetentionDays: null,
      actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
    });
  }
  afterAll(keepEverything);

  test("AUDIT_RETENTION_DAYS reaches Intelligence, with Action Recording's 90 days", async () => {
    const { client } = useTestAuditTrail();
    const config = loadConfig({
      ...testEnvironment(),
      AUDIT_RETENTION_DAYS: "90",
    });
    await keepEverything();

    await expect(
      syncAuditRetention(client, {
        eventRetentionDays: config.auditRetentionDays ?? null,
        actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
      }),
    ).resolves.toBe("saved");

    expect(await client.settings()).toMatchObject({
      eventRetentionDays: 90,
      actionRetentionDays: 90,
    });
    // Booting again with the same window changes nothing.
    await expect(
      syncAuditRetention(client, {
        eventRetentionDays: 90,
        actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
      }),
    ).resolves.toBe("unchanged");
  });

  test("keeps everything when no policy is set", async () => {
    // The default, and the safe one. Deleting somebody's trail because a default said so is worse
    // than a table that grows, so an unset window is said to Intelligence as "keep forever".
    const { client } = useTestAuditTrail();
    const config = loadConfig({ ...testEnvironment() });
    expect(config.auditRetentionDays).toBeUndefined();
    await syncAuditRetention(client, {
      eventRetentionDays: 30,
      actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
    });

    await syncAuditRetention(client, {
      eventRetentionDays: config.auditRetentionDays ?? null,
      actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
    });

    expect(await client.settings()).toMatchObject({ eventRetentionDays: null });
  });

  test("two servers booting at once both end with the window, and neither puts back what it read", async () => {
    /*
     * Each reads the settings' version and saves under it (If-Match). The one that loses the race is
     * refused, reads again, finds the window already there, and stops. Without the version, the
     * slower one could put back whatever it had read.
     */
    const { client } = useTestAuditTrail();
    await keepEverything();
    const wanted = {
      eventRetentionDays: 365,
      actionRetentionDays: ACTION_RECORD_RETENTION_DAYS,
    };
    const results = await Promise.all([
      syncAuditRetention(client, wanted),
      syncAuditRetention(client, wanted),
    ]);
    expect(results).toContain("saved");
    expect(await client.settings()).toMatchObject({ eventRetentionDays: 365 });
  });

  test("a save that keeps losing to another writer is said, not swallowed", async () => {
    let version = 1;
    const contested: Pick<AuditTrailClient, "settings" | "putSettings"> = {
      settings: async () => ({
        eventRetentionDays: null,
        actionRetentionDays: 90,
        version: version++,
      }),
      putSettings: async () => null,
    };
    await expect(
      syncAuditRetention(contested, {
        eventRetentionDays: 90,
        actionRetentionDays: 90,
      }),
    ).rejects.toThrow(/kept changing/);
  });
});

describe("the local audit_events table, kept for the copy, stays append-only", () => {
  test("a row one day inside the declared window cannot be deleted, one day outside it can", async () => {
    // The boundary. Off by a day here means a deployment promising 90 days keeps 89.
    await event(89, 1);
    await event(91, 2);

    await database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('openbot.audit_retention_days', '90', true)`,
      );
      await tx
        .delete(auditEvents)
        .where(eq(auditEvents.targetId, `${MARKER}-2`));
    });
    expect(await remaining()).toBe(1);

    expect(
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('openbot.audit_retention_days', '90', true)`,
          );
          await tx
            .delete(auditEvents)
            .where(eq(auditEvents.targetId, `${MARKER}-1`));
        }),
      ),
    ).toBe(true);
    expect(await remaining()).toBe(1);
  });

  test("the database refuses a malformed window even when the caller does not", async () => {
    /*
     * The sweep that once ran here refused a malformed window in TypeScript before it ever opened a
     * connection, which proved the caller's guard and said nothing about the trigger, which has a
     * branch of its own for this that nothing exercised. That is the shape where a guard reads
     * as covered and is not: anything reaching the table without going through the sweep meets the
     * trigger and only the trigger.
     *
     * These set the value the sweep would have set and then delete directly.
     *
     * Reported by @beardthelion.
     */
    await event(400, 1);

    for (const window of ["0", "-1", "", "garbage"]) {
      expect(
        await refusedAsAppendOnly(() =>
          database.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('openbot.audit_retention_days', ${window}, true)`,
            );
            await tx
              .delete(auditEvents)
              .where(eq(auditEvents.targetType, MARKER));
          }),
        ),
      ).toBe(true);
    }
    expect(await remaining()).toBe(1);
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

  /*
   * TRUNCATE, which for a while was the one statement that emptied this table and raised nothing.
   *
   * The append-only guarantee was a row-level trigger, and a row-level trigger cannot fire on a
   * statement that removes rows without visiting them. So UPDATE and DELETE were refused while
   * `TRUNCATE audit_events` took the lot and reported success.
   *
   * The transaction always throws, so it always rolls back. That is not tidiness: if this ever
   * regresses, a committed truncate here would destroy the audit trail of whatever database the
   * suite is pointed at, and the run that discovers the bug must not also be the run that proves
   * how bad it is. A truncate that goes through leaves the sentinel on the cause chain instead of
   * the refusal, so the assertion fails with the table still whole.
   */
  const ROLLED_BACK = "rolled back on purpose, never committed";

  test("the whole table cannot be truncated", async () => {
    await event(400, 1);

    expect(
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(sql`truncate table audit_events`);
          throw new Error(ROLLED_BACK);
        }),
      ),
    ).toBe(true);

    expect(await remaining()).toBe(1);
  });

  test("a declared retention window does not open the door to it", async () => {
    /*
     * The failure mode of the obvious fix, and the reason the trigger answers TG_OP before it reads
     * anything. Pointing a statement-level trigger at a function that tests `OLD.created_at`
     * compares against NULL, because a statement trigger has no OLD record, and falls straight
     * through to the return that lets the statement proceed.
     *
     * That path opens exactly while a retention sweep has the window set, so a happy-path check
     * with no setting would report the guard working and miss it entirely. Both states are checked
     * here, and this is the one that matters.
     */
    await event(400, 1);

    expect(
      await refusedAsAppendOnly(() =>
        database.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('openbot.audit_retention_days', '30', true)`,
          );
          await tx.execute(sql`truncate table audit_events`);
          throw new Error(ROLLED_BACK);
        }),
      ),
    ).toBe(true);

    expect(await remaining()).toBe(1);
  });
});

afterAll(async () => {
  await database.$client.close();
});
