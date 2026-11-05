import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createActivityStore } from "../src/activity/activity";
import { HANDOFF_KIND } from "../src/agents/handoff";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Pausing a Bot stops the work it already handed on, against a real PostgreSQL.
 *
 * Pause is enforced where work starts, and a hop is work the asking Bot started. Checked only
 * against the Bot being asked, a hop queued by a Bot its person has since paused still ran the other
 * Bot's turn, in the paused Bot's name, and its answer was dropped on the way home: a model call
 * nobody could see, for a Bot that was meant to have stopped.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createWorkQueue(database);
const lifecycle = createBotLifecycleStore(database);
const activity = createActivityStore(database);
const prefix = `paused-asker-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const asker = `${prefix}-asker`;
const helper = `${prefix}-helper`;

let written: AuditEventInput[] = [];
const auditStore: AuditStore = {
  // This file's runs only, for the same reason the report is filtered below.
  insert: async (event) => {
    if (event.payload.run === `${prefix}-run`) written.push(event);
  },
};

function hop(
  key: string,
  overrides: Partial<HandoffWork> = {},
): { key: string; work: HandoffWork } {
  return {
    key,
    work: {
      fromBotId: asker,
      toBotId: helper,
      actorId: owner,
      threadId: `${prefix}-thread`,
      runId: `${prefix}-run`,
      depth: 1,
      task: `task ${key}`,
      ...overrides,
    },
  };
}

async function offer(...hops: { key: string; work: HandoffWork }[]) {
  for (const { key, work } of hops)
    await queue.offer({
      kind: HANDOFF_KIND,
      key,
      payload: work as unknown as Record<string, unknown>,
    });
}

/**
 * The runner claims every due hop of its kind, oldest first, and other files on this database queue
 * hops of their own. This file's open rows are moved to the front and the claim is sized to exactly
 * them, so a sweep here never takes, finishes or retries a row that belongs to another file.
 */
const mine = (key: string) => key.startsWith(prefix);

async function frontOfTheQueue(): Promise<number> {
  const open = and(ours, isNull(workItems.finishedAt));
  await database
    .update(workItems)
    .set({ runAt: sql`'-infinity'::timestamptz` })
    .where(open);
  const [{ count }] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(workItems)
    .where(open);
  return count;
}

async function sweep(delivered: string[]) {
  const limit = await frontOfTheQueue();
  const report = await runner(delivered, limit).sweep();
  return {
    delivered: report.delivered.filter(
      (bot) => bot === helper || bot === asker,
    ),
    skipped: report.skipped.filter((entry) => mine(entry.key)),
  };
}

function runner(delivered: string[], limit: number) {
  return createHandoffRunner({
    queue,
    owner: `${prefix}-replica`,
    sign: () => "signed",
    auditStore,
    limit,
    delivery: {
      deliver: async ({ work }) => {
        if (work.runId === `${prefix}-run`)
          delivered.push(`${work.fromBotId}->${work.toBotId}`);
        return { answer: null };
      },
    },
  });
}

async function row(key: string) {
  const [found] = await database
    .select()
    .from(workItems)
    .where(and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, key)));
  return found;
}

const ours = sql`${workItems.key} like ${`%${prefix}%`}`;

beforeAll(async () => {
  configureBotLifecycle({ database });
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: asker, name: "Asker", type: "built_in", configuration: {} },
    { id: helper, name: "Helper", type: "built_in", configuration: {} },
  ]);
});

beforeEach(async () => {
  written = [];
  await database.delete(workItems).where(ours);
  for (const person of [owner, other])
    for (const bot of [asker, helper]) await lifecycle.resume(person, bot);
});

afterAll(async () => {
  resetBotLifecycleForTests();
  await database.delete(workItems).where(ours);
  await database.delete(agents).where(inArray(agents.id, [asker, helper]));
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

describe("a hop whose asking Bot is paused", () => {
  test("is dropped, not delivered, and the row says why", async () => {
    await offer(hop(`${prefix}:forward`));
    await lifecycle.pause(owner, asker);

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(delivered).toEqual([]);
    expect(report.delivered).toEqual([]);
    expect(report.skipped).toEqual([
      {
        key: `${prefix}:forward`,
        reason: "The Bot that asked is paused, so this was not passed on.",
      },
    ]);
    const stored = await row(`${prefix}:forward`);
    expect(stored?.finishedAt).not.toBeNull();
    expect(stored?.lastError).toBe(
      "The Bot that asked is paused, so this was not passed on.",
    );
  });

  test("is recorded on the trail as skipped, naming both Bots", async () => {
    await offer(hop(`${prefix}:audited`));
    await lifecycle.pause(owner, asker);

    await sweep([]);

    const skipped = written.filter(
      (event) => event.eventType === "agent.handoff_skipped",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      targetType: "agent",
      targetId: helper,
      actorUserId: owner,
      payload: {
        bot: asker,
        from: asker,
        to: helper,
        run: `${prefix}-run`,
        reason: "The Bot that asked is paused, so this was not passed on.",
      },
    });
  });

  test("reads as skipped in the asking Bot's Activity, not delivered", async () => {
    await offer(hop(`${prefix}:activity`));
    await lifecycle.pause(owner, asker);

    await sweep([]);

    const result = await activity.forBot(owner, asker);
    const item = result.completed.find(
      (entry) => entry.id === `${prefix}:activity`,
    );
    expect(item?.status).toBe("skipped");
    expect(item?.stoppable).toBe(false);
  });

  test("is one person's pause: another person's hop from the same Bot is delivered", async () => {
    await offer(
      hop(`${prefix}:theirs`, { actorId: other }),
      hop(`${prefix}:mine`),
    );
    await lifecycle.pause(owner, asker);

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(report.delivered).toEqual([helper]);
    expect(report.skipped.map((entry) => entry.key)).toEqual([
      `${prefix}:mine`,
    ]);
    const theirs = await row(`${prefix}:theirs`);
    expect(theirs?.finishedAt).not.toBeNull();
    expect(theirs?.lastError).toBeNull();
  });
});

describe("the hops around it", () => {
  test("an answer coming home is still delivered when only the Bot that answered is paused", async () => {
    // A relay runs the asking Bot, in the conversation the person is watching. The Bot that answered
    // has already done its part; pausing it afterwards is not a reason to lose the answer.
    await offer(
      hop(`${prefix}:relay-home`, {
        fromBotId: helper,
        toBotId: asker,
        answerIn: `${prefix}-thread`,
      }),
    );
    await lifecycle.pause(owner, helper);

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(delivered).toEqual([`${helper}->${asker}`]);
    expect(report.skipped).toEqual([]);
    expect((await row(`${prefix}:relay-home`))?.finishedAt).not.toBeNull();
    expect(
      written.filter((event) => event.eventType === "agent.handoff_skipped"),
    ).toEqual([]);
  });

  test("so is a notice that the Bot asked never answered", async () => {
    await offer(
      hop(`${prefix}:notice-home`, {
        fromBotId: helper,
        toBotId: asker,
        answerIn: `${prefix}-thread`,
        task: "It never answered.",
      }),
    );
    await lifecycle.pause(owner, helper);

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(delivered).toEqual([`${helper}->${asker}`]);
    expect(report.skipped).toEqual([]);
  });

  test("a hop delivered after a pause was lifted reads as delivered, not as the pause it outlived", async () => {
    // A pause that lands while a hop is being delivered stops the turn, and the queue keeps the
    // pause's sentence on the row for the retry. Resumed and delivered, the row is no longer that.
    const key = `${prefix}:outlived`;
    await offer(hop(key));
    const [claimed] = await queue.claim({
      kind: HANDOFF_KIND,
      owner: `${prefix}-earlier`,
      leaseMs: 60_000,
      limit: await frontOfTheQueue(),
    });
    expect(claimed?.key).toBe(key);
    await queue.release({
      kind: HANDOFF_KIND,
      key,
      owner: `${prefix}-earlier`,
      delayMs: -1_000,
      reason: "The Bot is paused, so it did not run.",
    });

    const delivered: string[] = [];
    await sweep(delivered);

    expect(delivered).toEqual([`${asker}->${helper}`]);
    expect((await row(key))?.lastError).toBeNull();
    const result = await activity.forBot(owner, asker);
    expect(result.completed.find((entry) => entry.id === key)?.status).toBe(
      "delivered",
    );
  });

  test("a hop to a paused Bot is still dropped, and now reads as skipped too", async () => {
    await offer(hop(`${prefix}:to-paused`));
    await lifecycle.pause(owner, helper);

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(delivered).toEqual([]);
    expect(report.skipped).toEqual([
      {
        key: `${prefix}:to-paused`,
        reason: "The Bot is paused, so it did not run.",
      },
    ]);
    expect((await row(`${prefix}:to-paused`))?.lastError).toBe(
      "The Bot is paused, so it did not run.",
    );
    expect(
      written.filter((event) => event.eventType === "agent.handoff_skipped"),
    ).toHaveLength(1);
    const result = await activity.forBot(owner, asker);
    expect(
      result.completed.find((entry) => entry.id === `${prefix}:to-paused`)
        ?.status,
    ).toBe("skipped");
  });

  test("with neither Bot paused, the hop is delivered as before", async () => {
    await offer(hop(`${prefix}:plain`));

    const delivered: string[] = [];
    const report = await sweep(delivered);

    expect(delivered).toEqual([`${asker}->${helper}`]);
    expect(report.skipped).toEqual([]);
    const result = await activity.forBot(owner, asker);
    expect(
      result.completed.find((entry) => entry.id === `${prefix}:plain`)?.status,
    ).toBe("delivered");
  });
});
