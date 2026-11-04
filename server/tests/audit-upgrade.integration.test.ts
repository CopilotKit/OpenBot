/**
 * An upgrading deployment's audit trail, action records and model usage, copied into Intelligence.
 *
 * Before this release they lived in `audit_events`, `action_records` and `model_usage`. The copy
 * (`audit-trail/upgrade.ts`) moves every row once, with its id and moment, verified by count and
 * recorded in `intelligence_copies`; it resumes where it stopped and is safe from two servers at once.
 * Against a real database seeded the way the previous release wrote it, and the real test Intelligence.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { createAuditTrailClient } from "../src/audit-trail/client";
import {
  AUDIT_COPIES,
  copyAuditHistory,
  copyAuditTable,
  startAuditHistoryCopy,
} from "../src/audit-trail/upgrade";
import { createDatabase } from "../src/db/client";
import {
  actionRecords,
  auditEvents,
  intelligenceCopies,
  intelligenceCopyProgress,
  modelUsage,
} from "../src/db/schema";
import {
  actionRows,
  auditRows,
  modelUsageRows,
  useTestAuditTrail,
} from "./support/audit";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const { client } = useTestAuditTrail();
const names = AUDIT_COPIES.map((copy) => copy.table);
const [eventsCopy] = AUDIT_COPIES;
if (!eventsCopy) throw new Error("no audit_events copy");

/** A client of the real test Intelligence that notes every id it sends, and can fail after `n` sends. */
function countingClient(failAfter = Number.POSITIVE_INFINITY) {
  const intelligence = testIntelligence();
  const state = { sends: 0, sent: [] as string[] };
  return {
    state,
    client: createAuditTrailClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          if (state.sends >= failAfter)
            throw new TypeError("fetch failed: the server stopped");
          state.sends += 1;
          const body = JSON.parse(String(init.body)) as Record<
            string,
            { id: string }[]
          >;
          for (const records of Object.values(body))
            state.sent.push(...records.map((record) => record.id));
        }
        return fetch(input, init);
      }) as typeof fetch,
    }),
  };
}

/** As if this deployment had never copied: the record and the bookmarks gone. */
beforeEach(async () => {
  await database
    .delete(intelligenceCopies)
    .where(inArray(intelligenceCopies.name, names));
  await database
    .delete(intelligenceCopyProgress)
    .where(inArray(intelligenceCopyProgress.name, names));
});

afterAll(async () => {
  await database.$client.close();
});

const daysAgo = (days: number, micros = 0) =>
  sql`now() - ${days}::int * interval '1 day' + ${micros}::int * interval '1 microsecond'`;

/** Rows the previous release wrote, a month ago, two of them in one instant. */
async function seedPreviousRelease() {
  const suite = randomUUID();
  const targetId = `upgrade-${suite}`;
  const bot = `upgrade-bot-${suite}`;
  const events = await database
    .insert(auditEvents)
    .values([
      {
        eventType: "mcp.call_succeeded",
        actorUserId: `upgrade-user-${suite}`,
        initiatorKind: "routine",
        initiatorId: `routine-${suite}`,
        targetType: "upgrade_test",
        targetId,
        payload: { bot, decision: { allowed: true } },
        createdAt: daysAgo(30, 1),
      },
      {
        eventType: "computer.action_refused",
        targetType: "upgrade_test",
        targetId,
        payload: { bot },
        createdAt: daysAgo(30, 2),
      },
      {
        eventType: "configuration.changed",
        actorUserId: "",
        targetType: "upgrade_test",
        targetId,
        payload: {},
        createdAt: daysAgo(30, 2),
      },
    ])
    .returning({
      id: auditEvents.id,
      createdAt: sql<string>`to_char(${auditEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    });
  await database.insert(actionRecords).values([
    {
      surface: "cloud",
      botId: bot,
      actorUserId: `upgrade-user-${suite}`,
      toolName: "computer_run_command",
      command: "ls -la",
      outcome: "allowed",
      createdAt: daysAgo(20),
    },
  ]);
  await database.insert(modelUsage).values([
    {
      userId: `upgrade-user-${suite}`,
      agentId: bot,
      threadId: "thread-1",
      runId: "run-1",
      model: "openai/gpt-upgrade",
      source: "configured",
      allowed: false,
      createdAt: daysAgo(10),
    },
  ]);
  return { targetId, bot, events };
}

async function localCount(table: string) {
  const [row] = (await database.execute(
    sql`select count(*)::int as n from ${sql.raw(table)}`,
  )) as unknown as { n: number }[];
  return Number(row?.n);
}

describe("copying an upgraded deployment's trail into Intelligence", () => {
  test("every row arrives with its id and moment, and the copy records itself once the count holds", async () => {
    const { targetId, bot, events } = await seedPreviousRelease();

    const outcomes = await copyAuditHistory(database, client);

    for (const name of names) {
      const local = await localCount(name);
      expect(outcomes[name]).toEqual({
        kind: "copied",
        local,
        stored: local,
      });
    }
    const stored = await auditRows({ targetId });
    expect(
      stored
        .map((row) => ({ id: row.id, at: row.occurredAt }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(
      events
        .map((row) => ({ id: row.id, at: row.createdAt }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(
      stored.find((row) => row.eventType === "mcp.call_succeeded"),
    ).toMatchObject({
      initiatorKind: "routine",
      initiatorId: expect.stringMatching(/^routine-/),
      actorUserId: expect.stringMatching(/^upgrade-user-/),
      payload: { bot, decision: { allowed: true } },
    });
    // A blank actor named nobody, and is carried as nobody.
    expect(
      stored.find((row) => row.eventType === "configuration.changed")
        ?.actorUserId,
    ).toBeNull();
    expect(await actionRows(bot)).toMatchObject([
      {
        surface: "cloud",
        agentId: bot,
        toolName: "computer_run_command",
        command: "ls -la",
        outcome: "allowed",
      },
    ]);
    expect(await modelUsageRows(bot)).toMatchObject([
      {
        agentId: bot,
        model: "openai/gpt-upgrade",
        source: "configured",
        allowed: false,
        threadId: "thread-1",
        runId: "run-1",
      },
    ]);

    const recorded = await database
      .select()
      .from(intelligenceCopies)
      .where(inArray(intelligenceCopies.name, names));
    expect(recorded).toHaveLength(3);
    for (const row of recorded) {
      expect(row.copied).toBe(await localCount(row.name));
    }

    // Recorded means never again: a second boot sends nothing.
    const again = countingClient();
    expect(await copyAuditHistory(database, again.client)).toEqual({
      audit_events: { kind: "done-before" },
      action_records: { kind: "done-before" },
      model_usage: { kind: "done-before" },
    });
    expect(again.state.sent).toEqual([]);
  });

  test("a copy cut off part-way resumes from its bookmark rather than starting over", async () => {
    // More rows than the first attempt gets through, whatever else this database holds: a test run
    // alone, or after one that took old rows out, finds fewer than that already there.
    while ((await localCount("audit_events")) <= 6) await seedPreviousRelease();
    const local = await localCount("audit_events");
    expect(local).toBeGreaterThan(6);

    const first = countingClient(2);
    await expect(
      copyAuditTable(database, first.client, eventsCopy, { batchSize: 3 }),
    ).rejects.toThrow();
    expect(first.state.sent).toHaveLength(6);
    const [bookmark] = await database
      .select()
      .from(intelligenceCopyProgress)
      .where(inArray(intelligenceCopyProgress.name, ["audit_events"]));
    expect(bookmark?.copied).toBe(6);

    const second = countingClient();
    expect(
      await copyAuditTable(database, second.client, eventsCopy, {
        batchSize: 3,
      }),
    ).toEqual({ kind: "copied", local, stored: local });
    // Nothing the first attempt delivered was sent again.
    expect(
      second.state.sent.filter((id) => first.state.sent.includes(id)),
    ).toEqual([]);
    expect(second.state.sent).toHaveLength(local - 6);
  });

  test("two servers copying at once: one copies, the other waits its turn, and each row is sent once", async () => {
    await seedPreviousRelease();
    const a = countingClient();
    const b = countingClient();

    const outcomes = await Promise.all([
      copyAuditTable(database, a.client, eventsCopy),
      copyAuditTable(database, b.client, eventsCopy),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).toSorted()).toEqual([
      "busy",
      "copied",
    ]);
    const sent = [...a.state.sent, ...b.state.sent];
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent).toHaveLength(await localCount("audit_events"));
    expect(await copyAuditTable(database, b.client, eventsCopy)).toEqual({
      kind: "done-before",
    });
  });

  test("a row Intelligence refuses leaves the copy unrecorded, and says which", async () => {
    const [poison] = await database
      .insert(auditEvents)
      .values({
        eventType: "configuration.changed",
        targetType: "upgrade_test",
        targetId: `upgrade-poison-${randomUUID()}`,
        // Past the 64 KB a payload may be in Intelligence.
        payload: { notes: "x".repeat(70 * 1024) },
        createdAt: daysAgo(400),
      })
      .returning({ id: auditEvents.id });
    const said: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => {
      said.push(String(line));
    };
    try {
      const outcome = await copyAuditTable(database, client, eventsCopy);
      expect(outcome.kind).toBe("short");
      if (outcome.kind !== "short") return;
      expect(outcome.stored).toBe(outcome.local - 1);
      expect(outcome.refused).toEqual([
        expect.stringContaining(poison?.id ?? "-"),
      ]);
      expect(
        said.some(
          (line) =>
            line.includes('"audit-copy-short"') &&
            line.includes(poison?.id ?? "-"),
        ),
      ).toBe(true);
      expect(
        await database
          .select()
          .from(intelligenceCopies)
          .where(inArray(intelligenceCopies.name, ["audit_events"])),
      ).toEqual([]);
    } finally {
      console.error = error;
      // Out of the table again, the only way the trail allows: a declared window it is outside of.
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('openbot.audit_retention_days', '365', true)`,
        );
        await tx
          .delete(auditEvents)
          .where(inArray(auditEvents.id, [poison?.id ?? randomUUID()]));
      });
    }
  });

  test("at boot the copy runs in the background and finishes on its own", async () => {
    await seedPreviousRelease();
    const copy = startAuditHistoryCopy(database, client, { retryMs: 50 });
    await copy.finished;
    copy.stop();
    expect(
      (
        await database
          .select({ name: intelligenceCopies.name })
          .from(intelligenceCopies)
          .where(inArray(intelligenceCopies.name, names))
      )
        .map((row) => row.name)
        .toSorted(),
    ).toEqual([...names].toSorted());
  });
});
