import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { createHandoffDesk } from "../src/agents/handoff";
import {
  createHandoffRunner,
  type HandoffWork,
} from "../src/agents/handoff-runner";
import { handoffTool } from "../src/agents/handoff-tool";
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
 * A hop from end to end: a Bot calls the tool, and another replica delivers it.
 *
 * THE TWO HALVES NEVER SPEAK. Deciding happens in one run and delivering in another process, and the
 * only thing between them is a row. That is the property worth an integration test: unit tests on
 * either side pass while the row they agree on is written by one and unreadable by the other.
 *
 * The delivery is faked and nothing else is. Running a real model against a real thread is not what
 * this is asking about, and it would make the test slow, expensive and non-deterministic for a
 * question the two files either side already answer.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const ASKER = `e2e-asker-${suite}`;
const TARGET = `e2e-target-${suite}`;
const ACTOR = `e2e-actor-${suite}`;
const RUN = `e2e-run-${suite}`;
const KIND = `bot.message.test.${suite}`;

const queue = createWorkQueue(database);
const auditStore = createAuditStore(database);
const profiles = createAgentProfileStore(database);

const desk = createHandoffDesk({
  queue,
  kind: KIND,
  profiles,
  // The person's own role, as the request path resolves it: an administrator sees Bots a user does
  // not, and a hop to one of those is theirs to make.
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, fromBotId),
          ),
        )
    ).some((row) => row.ref === toBotId),
  auditStore,
  caps: { maxDepth: 2, maxPerRun: 3 },
});

async function clean() {
  await database.delete(workItems).where(like(workItems.key, `${RUN}%`));
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
  await database
    .insert(pluginGrants)
    .values({ kind: "bot", ref: TARGET, agentId: ASKER, grantedBy: "test" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("a hop, from the tool call to the delivery", () => {
  test("what one Bot asked for is what the other is shown", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });

    // The asking Bot's own words, through the tool it is offered.
    const said = await tool?.execute({
      bot: "Target",
      task: "find the outage window",
      constraints: "yesterday only",
      expecting: "a date range",
    });
    expect(said).toContain("Target");

    // A different process entirely, sharing nothing but the row.
    const delivered: Array<{ work: HandoffWork; message: string }> = [];
    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      kind: KIND,
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: {
        deliver: async ({ work, message }) => {
          delivered.push({ work, message });
          return { answer: null };
        },
      },
    });

    const report = await runner.sweep();

    expect(report.delivered).toContain(TARGET);
    const seen = delivered.find((entry) => entry.work.toBotId === TARGET);
    expect(seen?.work).toMatchObject({
      fromBotId: ASKER,
      actorId: ACTOR,
      threadId: `thread-${suite}`,
      depth: 1,
    });
    // Every part the asking model was made to name survives to the other side.
    expect(seen?.message).toContain("find the outage window");
    expect(seen?.message).toContain("yesterday only");
    expect(seen?.message).toContain("a date range");
    // Attributed by the deployment, from the row rather than from anything a model wrote.
    expect(seen?.message).toContain(ASKER);
  });

  test("a delivered hop is finished, so a second sweep does not run the Bot again", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });
    await tool?.execute({ bot: "Target", task: "have a look" });

    const sweepWith = (owner: string) => {
      const seen: string[] = [];
      return {
        seen,
        runner: createHandoffRunner({
          queue: createWorkQueue(database),
          kind: KIND,
          owner,
          sign: () => "signed",
          auditStore,
          delivery: {
            deliver: async ({ work }) => {
              seen.push(work.toBotId);
              return { answer: null };
            },
          },
        }),
      };
    };

    const first = sweepWith(`replica-a-${suite}`);
    await first.runner.sweep();
    const second = sweepWith(`replica-b-${suite}`);
    await second.runner.sweep();

    expect(first.seen).toEqual([TARGET]);
    // The row is finished rather than deleted, so re-offering the same hop collides too.
    expect(second.seen).toEqual([]);
  });

  test("the whole path leaves a trail somebody can follow", async () => {
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: RUN,
        threadId: `thread-${suite}`,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
    });
    await tool?.execute({ bot: "Target", task: "have a look" });

    const runner = createHandoffRunner({
      queue: createWorkQueue(database),
      kind: KIND,
      owner: `replica-${suite}`,
      sign: () => "signed",
      auditStore,
      delivery: { deliver: async () => ({ answer: null }) },
    });
    await runner.sweep();

    const rows = await database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(eq(auditEvents.targetId, TARGET));
    const kinds = rows.map((row) => row.eventType);
    expect(kinds).toContain("agent.handoff_offered");
    expect(kinds).toContain("agent.handoff_delivered");
    expect(
      rows.every((row) => (row.payload as { run?: string }).run === RUN),
    ).toBe(true);
  });
});
