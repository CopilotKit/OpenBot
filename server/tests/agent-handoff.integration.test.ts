import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

/**
 * A hop, driven against the real database rather than through fakes.
 *
 * Three of the four properties here belong to Postgres rather than to the code: whether a second
 * offer of the same hop collides, whether the fan-out count sees rows another replica wrote, and
 * whether a grant read now reflects one made a moment ago. A fake answers all three the way its
 * author expected, which is the wrong witness for exactly the questions worth asking.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const ASKER = `handoff-asker-${suite}`;
const TARGET = `handoff-target-${suite}`;
const ACTOR = `handoff-actor-${suite}`;

const profiles = createAgentProfileStore(database);
const queue = createWorkQueue(database);
const desk = createHandoffDesk({
  queue,
  profiles,
  // The person's own role, as the request path resolves it: an administrator sees Bots a user does
  // not, and a hop to one of those is theirs to make.
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) => {
    const rows = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "bot"), eq(pluginGrants.agentId, fromBotId)),
      );
    return rows.some((row) => row.ref === toBotId);
  },
  auditStore: createAuditStore(database),
  caps: { maxDepth: 2, maxPerRun: 2 },
});

async function clean() {
  await database.delete(workItems).where(like(workItems.key, `run-${suite}%`));
  for (const id of [ASKER, TARGET]) {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, id));
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
    await database.delete(agents).where(eq(agents.id, id));
  }
}

beforeEach(async () => {
  await clean();
  for (const [id, name] of [
    [ASKER, "Asker"],
    [TARGET, "Target"],
  ]) {
    await database
      .insert(agents)
      .values({ id, name, type: "built_in", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        name,
        title: "",
        roleDescription: "",
        avatarSeed: id,
        visibility: "public",
      })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

const from = (over: Partial<{ runId: string; depth: number }> = {}) => ({
  botId: ASKER,
  actorId: ACTOR,
  runId: `run-${suite}-1`,
  threadId: `thread-${suite}`,
  depth: 0,
  ...over,
});

async function grantTarget() {
  await database
    .insert(pluginGrants)
    .values({ kind: "bot", ref: TARGET, agentId: ASKER, grantedBy: "test" })
    .onConflictDoNothing();
}

describe("a hop, against the database", () => {
  test("an ungranted Bot is refused, and granting it now is enough", async () => {
    const before = await desk.send({
      from: from(),
      target: "Target",
      envelope: { task: "have a look" },
    });
    expect(before.ok).toBe(false);

    // Read per hop and never held, so this applies to the very next one rather than after a restart.
    await grantTarget();

    const after = await desk.send({
      from: from(),
      target: "Target",
      envelope: { task: "have a look" },
    });
    expect(after).toMatchObject({ ok: true, to: TARGET });
  });

  /*
   * The key is the only thing between a retried delivery and a second run of the receiving Bot, and
   * it is the database that decides whether two offers collide.
   */
  test("the same hop offered twice leaves one row", async () => {
    await grantTarget();
    const send = () =>
      desk.send({
        from: from(),
        target: "Target",
        envelope: { task: "have a look" },
      });

    await send();
    await send();

    /*
     * Found by payload rather than by key prefix. The run is HASHED into the key — `runId` arrives
     * on the request, and written in raw a run calling itself `notice` aliased the prefix every
     * failure notice is keyed under — so a test that greps for the raw id is asserting the bug.
     */
    const rows = await database
      .select({ key: workItems.key, payload: workItems.payload })
      .from(workItems)
      .where(eq(workItems.kind, HANDOFF_KIND));
    const mine = rows.filter(
      (row) => (row.payload as { runId?: string }).runId === `run-${suite}-1`,
    );
    expect(mine).toHaveLength(1);
    // And the id the caller chose is nowhere in the key it produced.
    expect(mine[0]?.key).not.toContain(`run-${suite}-1`);
  });

  /*
   * Counted from rows rather than a variable, because the hops of one run land on several pods and a
   * count held in a process counts one of them.
   */
  test("the fan-out cap counts rows another replica could have written", async () => {
    await grantTarget();
    const runId = `run-${suite}-2`;

    expect(
      (
        await desk.send({
          from: from({ runId }),
          target: "Target",
          envelope: { task: "first" },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await desk.send({
          from: from({ runId }),
          target: "Target",
          envelope: { task: "second" },
        })
      ).ok,
    ).toBe(true);

    // Two is the cap for this suite, so the third is refused whichever replica asks.
    const third = await desk.send({
      from: from({ runId }),
      target: "Target",
      envelope: { task: "third" },
    });
    expect(third.ok).toBe(false);
  });

  test("a chain at the cap is refused and leaves a row saying why", async () => {
    await grantTarget();
    const runId = `run-${suite}-3`;

    const outcome = await desk.send({
      from: from({ runId, depth: 2 }),
      target: "Target",
      envelope: { task: "keep going" },
    });

    expect(outcome.ok).toBe(false);
    const rows = await database
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "agent.handoff_refused"));
    expect(
      rows.some(
        (row) =>
          (row.payload as { run?: string; reason?: string }).run === runId &&
          (row.payload as { reason?: string }).reason === "depth_cap",
      ),
    ).toBe(true);
  });

  test("an accepted hop carries the actor, the thread and the next depth", async () => {
    await grantTarget();
    const runId = `run-${suite}-4`;

    await desk.send({
      from: from({ runId, depth: 1 }),
      target: "Target",
      envelope: { task: "have a look", expecting: "a date range" },
    });

    const rows = await database
      .select({ payload: workItems.payload })
      .from(workItems)
      .where(eq(workItems.kind, HANDOFF_KIND));
    const row = rows.find(
      (candidate) => (candidate.payload as { runId?: string }).runId === runId,
    );
    expect(row?.payload).toMatchObject({
      fromBotId: ASKER,
      toBotId: TARGET,
      actorId: ACTOR,
      threadId: `thread-${suite}`,
      depth: 2,
      task: "have a look",
      expecting: "a date range",
    });
  });
});
