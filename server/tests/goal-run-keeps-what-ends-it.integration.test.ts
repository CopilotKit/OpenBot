import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { withApprovalContext } from "@openbot/toolkit/continuation";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AuditInitiator } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { routines } from "../src/db/schema/coworker";
import { workItems } from "../src/db/schema/work";
import { ALWAYS_ON_APP } from "../src/plugins/personal-defaults";
import { runCalls } from "../src/plugins/run-calls";
import {
  callGoalTool,
  GOAL_TOOLS,
  useGoalTools,
  withRepeatingGoalsPinned,
} from "../src/responsibilities/chat-tools";
import { createResponsibilityRoutes } from "../src/responsibilities/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import {
  answerTurnTools,
  goalRunTools,
  responsibilityTools,
} from "../src/responsibilities/tools";
import { createTriggerStore } from "../src/responsibilities/triggers";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A goal's own run can't change whether its goal repeats or what ends it.
 *
 * FOUND IN REVIEW: the run's `update_goal` took any patch, so a run of a goal a routine runs could
 * set `endsWhenMet`, then `complete_goal`: the goal ended, and its routine was switched off, though
 * only the person ends a goal that repeats. The same for `recurring: false`, clearing the event
 * subscriptions, and blanking the success criteria `create_goal` makes a Bot give. Renaming a goal an
 * older routine runs by its quoted title unlinked that routine, and rewriting the success criteria of
 * a goal that ends when met changed what ends it: both are refused too.
 *
 * Nor by switching off or deleting what makes it repeat, through the Routines app's own tools
 * (`update_routine`, `delete_routine`, `pause_trigger`, `delete_trigger`): a goal that repeated when
 * its run began is not completed by that run, whatever changed since.
 *
 * Real: PostgreSQL, the goal, routine and trigger stores (what those Routines tools call), a running
 * run, and the tools that run is handed. The person's own PATCH and Complete go through the goals
 * route.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-run-keeps-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const store = createResponsibilityStore(database, {
  async resolveTarget(owner, bot, channel) {
    return owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null;
  },
});
const routineStore = createRoutineStore(database);
const credentialStore = createCredentialStore(database);
const triggers = createTriggerStore(database, {
  store: credentialStore,
  reader: credentialStore,
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
});
const engine = { ingest: async () => ({}) } as never;
const keys: string[] = [];
const valid = {
  agentId: botId,
  channelId,
  title: "Track OpenBot releases",
  instruction: "Check the latest OpenBot release and say what changed",
  successCriteria: "The person knows what changed in the latest release",
};

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Goal run keeps test Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(routines).where(eq(routines.ownerUserId, ownerId));
  await database.delete(users).where(eq(users.id, ownerId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function routineRunning(goalId: string) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    instruction: "Check the latest release",
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalId,
  });
  return id;
}
async function routineEnabled(id: string) {
  const [row] = await database
    .select({ enabled: routines.enabled })
    .from(routines)
    .where(eq(routines.id, id));
  return row?.enabled;
}
async function runningRun(goalId: string) {
  const queued = await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: goalId,
    payload: {},
  });
  keys.push(...queued.runIds);
  const runId = queued.runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  await store.beginRun(runId);
  return runId;
}
function caller(tools: Awaited<ReturnType<typeof goalRunTools>>) {
  return async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`${name} missing`);
    return String(await tool.execute(args));
  };
}
/** The tools a goal's run is handed, as `wiring.ts` builds them. */
async function runTools(runId: string) {
  return caller(
    await goalRunTools({
      store,
      engine,
      ownerUserId: ownerId,
      agentId: botId,
      channelId,
      responsibilityRunId: runId,
    }),
  );
}
/** A conversation turn's goal tools, as `chat-tools.ts` builds them: sent by the person, or not. */
async function turnTools(notByPerson: boolean) {
  const goal = {
    store,
    engine,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
  };
  return caller(
    notByPerson
      ? responsibilityTools({
          ...goal,
          notByPerson: true,
          repeatedWhenRunBegan: await store.repeatingGoals(ownerId, botId),
        })
      : responsibilityTools(goal),
  );
}
/**
 * A goal an older routine runs by naming its quoted title (`goalByTitle`). The title is its own, so
 * the routine runs no other goal of this Bot.
 */
async function runByTitle(input: Record<string, unknown> = {}) {
  const title = `Track releases ${randomUUID()}`;
  const goal = await store.create(ownerId, { ...valid, title, ...input });
  await database.insert(routines).values({
    id: `routine_${randomUUID()}`,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    instruction: `Run the goal "${title}"`,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalByTitle: true,
  });
  return goal;
}
/** A goal with a running run, and that run's tools. */
async function inRun(input: Record<string, unknown>, routine = false) {
  const goal = await store.create(ownerId, { ...valid, ...input });
  const routineId = routine ? await routineRunning(goal.id) : null;
  const call = await runTools(await runningRun(goal.id));
  return { goal, routineId, call };
}

describe("a goal's own run", () => {
  test("can't set endsWhenMet on a goal a routine runs, and so can't complete it", async () => {
    const { goal, routineId, call } = await inRun({}, true);
    const answer = await call("update_goal", {
      id: goal.id,
      patch: { endsWhenMet: true },
    });
    expect(answer).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).endsWhenMet).toBe(false);
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
    await call("report_goal_progress", {
      id: goal.id,
      summary: "Nothing new.",
      complete: true,
    });
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
    if (!routineId) throw new Error("Expected a routine.");
    expect(await routineEnabled(routineId)).toBe(true);
  });

  test("can't stop a goal set up to repeat from recurring, and so can't complete it", async () => {
    const { goal, call } = await inRun({ recurring: true });
    expect(
      await call("update_goal", { id: goal.id, patch: { recurring: false } }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).recurring).toBe(true);
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("can't clear the events that wake its goal, and so can't complete it", async () => {
    const { goal, call } = await inRun({
      subscriptions: [{ source: "github", eventType: "release.published" }],
    });
    expect(
      await call("update_goal", { id: goal.id, patch: { subscriptions: [] } }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).subscriptions).toHaveLength(1);
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("can't clear its goal's success criteria", async () => {
    const { goal, call } = await inRun({}, true);
    expect(
      await call("update_goal", {
        id: goal.id,
        patch: { successCriteria: "" },
      }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).successCriteria).toBe(
      valid.successCriteria,
    );
  });

  test("can't loosen another goal of its Bot either, and so can't complete that one", async () => {
    const { call } = await inRun({}, true);
    const other = await store.create(ownerId, valid);
    await routineRunning(other.id);
    expect(
      await call("update_goal", { id: other.id, patch: { endsWhenMet: true } }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect(await call("complete_goal", { id: other.id })).toStartWith(
      "Refused. This goal repeats",
    );
  });

  test("can't rename a goal an older routine runs by its title, and so can't complete it", async () => {
    const goal = await runByTitle();
    expect(await store.repeats(ownerId, goal.id)).toBe("routine");
    const call = await runTools(await runningRun(goal.id));
    expect(
      await call("update_goal", {
        id: goal.id,
        patch: { title: `New name ${randomUUID()}` },
      }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).title).toBe(goal.title);
    expect(await store.repeats(ownerId, goal.id)).toBe("routine");
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("can't change the success criteria of a goal that ends when met", async () => {
    const { goal, call } = await inRun({ endsWhenMet: true }, true);
    expect(
      await call("update_goal", {
        id: goal.id,
        patch: { successCriteria: "something else" },
      }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).successCriteria).toBe(
      valid.successCriteria,
    );
  });

  test("still renames and rewrites the criteria of a goal that is done once", async () => {
    const { goal, call } = await inRun({});
    const title = `New name ${randomUUID()}`;
    expect(
      await call("update_goal", {
        id: goal.id,
        patch: { title, successCriteria: "something else" },
      }),
    ).not.toStartWith("Refused.");
    const after = await store.get(ownerId, goal.id);
    expect(after.title).toBe(title);
    expect(after.successCriteria).toBe("something else");
  });

  test("still renames a goal its routine records by id", async () => {
    const { goal, call } = await inRun({}, true);
    const title = `New name ${randomUUID()}`;
    expect(
      await call("update_goal", { id: goal.id, patch: { title } }),
    ).not.toStartWith("Refused.");
    expect((await store.get(ownerId, goal.id)).title).toBe(title);
    expect(await store.repeats(ownerId, goal.id)).toBe("routine");
  });

  test("still edits the instruction and success criteria, and may send back what is already set", async () => {
    const { goal, call } = await inRun(
      { subscriptions: [{ source: "github", eventType: "release.published" }] },
      true,
    );
    const answer = await call("update_goal", {
      id: goal.id,
      patch: {
        instruction: "Check the latest two OpenBot releases",
        successCriteria: "The person knows what changed in the last two",
        recurring: false,
        endsWhenMet: false,
        subscriptions: [{ source: "github", eventType: "release.published" }],
      },
    });
    expect(answer).not.toStartWith("Refused.");
    const after = await store.get(ownerId, goal.id);
    expect(after.instruction).toBe("Check the latest two OpenBot releases");
    expect(after.successCriteria).toBe(
      "The person knows what changed in the last two",
    );
  });
});

describe("the turn that resumes a goal after its question is answered", () => {
  async function answerTurn(runId: string | undefined) {
    const tools = await answerTurnTools({
      store,
      engine,
      ownerUserId: ownerId,
      agentId: botId,
      channelId,
      responsibilityRunId: runId,
    });
    return async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${name} missing`);
      return String(await tool.execute(args));
    };
  }

  test("with no run can't complete a goal a routine runs, or loosen what ends it", async () => {
    const goal = await store.create(ownerId, valid);
    await routineRunning(goal.id);
    const call = await answerTurn(undefined);
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
    expect(
      await call("update_goal", { id: goal.id, patch: { endsWhenMet: true } }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("with its run still can't complete a goal a routine runs", async () => {
    const goal = await store.create(ownerId, valid);
    await routineRunning(goal.id);
    const call = await answerTurn(await runningRun(goal.id));
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
  });
});
describe("a goal's own run, after what makes its goal repeat changes", () => {
  const complete = (
    call: Awaited<ReturnType<typeof inRun>>["call"],
    id: string,
  ) => call("complete_goal", { id });
  async function reportsComplete(
    call: Awaited<ReturnType<typeof inRun>>["call"],
    id: string,
  ) {
    return call("report_goal_progress", {
      id,
      summary: "The person knows what changed.",
      complete: true,
    });
  }

  test("switches off its goal's routine, and still can't complete it", async () => {
    const { goal, routineId, call } = await inRun({}, true);
    if (!routineId) throw new Error("Expected a routine.");
    // What `update_routine` with `enabled: false` calls.
    await routineStore.update(ownerId, routineId, { enabled: false });
    expect(await complete(call, goal.id)).toStartWith(
      "Refused. This goal repeated when this run began",
    );
    expect(await reportsComplete(call, goal.id)).toContain(
      "Recorded. This goal repeated when this run began",
    );
    const after = await store.get(ownerId, goal.id);
    expect(after.status).toBe("active");
    expect(after.progress).toBe("The person knows what changed.");
  });

  test("deletes its goal's routine, and still can't complete it", async () => {
    const { goal, routineId, call } = await inRun({}, true);
    if (!routineId) throw new Error("Expected a routine.");
    // What `delete_routine` calls.
    await routineStore.remove(ownerId, routineId);
    expect(await complete(call, goal.id)).toStartWith(
      "Refused. This goal repeated when this run began",
    );
    expect(await reportsComplete(call, goal.id)).toContain(
      "Recorded. This goal repeated when this run began",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("pauses or deletes its goal's trigger, and still can't complete it", async () => {
    for (const change of ["pause", "delete"] as const) {
      const goal = await store.create(ownerId, valid);
      const { trigger } = await triggers.create(ownerId, goal.id, {
        config: { kind: "webhook", filter: { eventTypes: ["release"] } },
      });
      const call = await runTools(await runningRun(goal.id));
      // What `pause_trigger` and `delete_trigger` call.
      if (change === "pause")
        await triggers.setEnabled(ownerId, trigger.id, false);
      else await triggers.remove(ownerId, trigger.id);
      expect(await complete(call, goal.id)).toStartWith(
        "Refused. This goal repeated when this run began",
      );
      expect(await reportsComplete(call, goal.id)).toContain(
        "Recorded. This goal repeated when this run began",
      );
      expect((await store.get(ownerId, goal.id)).status).toBe("active");
    }
  });

  test("has its goal's subscriptions cleared, and still can't complete it", async () => {
    const { goal, call } = await inRun({
      subscriptions: [{ source: "github", eventType: "release.published" }],
    });
    await store.update(ownerId, goal.id, { subscriptions: [] });
    expect(await complete(call, goal.id)).toStartWith(
      "Refused. This goal repeated when this run began",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("switches off another goal's routine, and still can't complete that one", async () => {
    const other = await store.create(ownerId, valid);
    const otherRoutine = await routineRunning(other.id);
    const { call } = await inRun({});
    await routineStore.update(ownerId, otherRoutine, { enabled: false });
    expect(await complete(call, other.id)).toStartWith(
      "Refused. This goal repeated when this run began",
    );
    expect((await store.get(ownerId, other.id)).status).toBe("active");
  });

  test("still can't complete a goal a routine made during the run runs", async () => {
    const { goal, call } = await inRun({});
    await routineRunning(goal.id);
    expect(await complete(call, goal.id)).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
  });

  test("still completes a goal that did not repeat when it began: no routine, or one that ends when met", async () => {
    const once = await inRun({});
    expect(await complete(once.call, once.goal.id)).not.toStartWith("Refused.");
    expect((await store.get(ownerId, once.goal.id)).status).toBe("completed");

    const met = await inRun({ endsWhenMet: true }, true);
    const accepted = await reportsComplete(met.call, met.goal.id);
    // A refused completion still answers "Recorded." plus a note saying the run can't complete it.
    expect(accepted).not.toContain("Recorded.");
    expect(accepted).not.toContain("can't complete it");
    expect(accepted).toContain('"status":"completed"');
    expect((await store.get(ownerId, met.goal.id)).status).toBe("completed");
    if (!met.routineId) throw new Error("Expected a routine.");
    expect(await routineEnabled(met.routineId)).toBe(false);
  });
});

describe("a conversation turn", () => {
  test("the person did not send can't rename a goal an older routine runs by its title, and so can't complete it", async () => {
    const goal = await runByTitle();
    const call = await turnTools(true);
    expect(
      await call("update_goal", {
        id: goal.id,
        patch: { title: `New name ${randomUUID()}` },
      }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("the person did not send can't change the success criteria of a goal that ends when met", async () => {
    const goal = await runByTitle({ endsWhenMet: true });
    expect(
      await (await turnTools(true))("update_goal", {
        id: goal.id,
        patch: { successCriteria: "something else" },
      }),
    ).toStartWith("Refused. A run can't change whether a goal");
    expect((await store.get(ownerId, goal.id)).successCriteria).toBe(
      valid.successCriteria,
    );
  });

  test("the person sent still renames a goal an older routine runs by its title, and rewrites what ends a goal", async () => {
    const goal = await runByTitle();
    const call = await turnTools(false);
    const title = `New name ${randomUUID()}`;
    expect(
      await call("update_goal", { id: goal.id, patch: { title } }),
    ).not.toStartWith("Refused.");
    expect((await store.get(ownerId, goal.id)).title).toBe(title);

    const met = await runByTitle({ endsWhenMet: true });
    expect(
      await call("update_goal", {
        id: met.id,
        patch: { successCriteria: "something else" },
      }),
    ).not.toStartWith("Refused.");
    expect((await store.get(ownerId, met.id)).successCriteria).toBe(
      "something else",
    );
  });
});

/*
 * A turn the person did not send: a routine's own firing, in the conversation. It holds the goal
 * tools the Routines app serves, and `update_routine`, loaded as the turn begins (`index.ts`,
 * `withRepeatingGoalsPinned`). Each call is made as the runner makes it, with the turn's initiator in
 * scope (`headless-tools.ts`), and waits its turn among the run's app calls (`grantedTools`).
 *
 * FOUND IN REVIEW: such a turn was checked only by what repeats when it asks, so a routine's own
 * turn could switch off or delete its goal's routine or trigger with the Routines app's tools, and
 * then complete the goal.
 */
describe("a conversation turn the person did not send, after what makes a goal repeat changes", () => {
  beforeAll(() =>
    useGoalTools({
      store,
      engine,
      conversationFor: routineStore.conversationFor,
    }),
  );
  afterAll(() => useGoalTools(null));

  async function turnBegins(initiator: AuditInitiator) {
    const runId = randomUUID();
    // One app call at a time, so a call made beside another waits behind it.
    const calls = runCalls(1);
    const appTool = (
      name: string,
      call: (args: Record<string, unknown>) => Promise<string>,
    ): GrantedTool => ({
      name,
      ref: `${ALWAYS_ON_APP}/${name}`,
      description: name,
      parameters: z.record(z.string(), z.unknown()),
      execute: (args) =>
        calls.call(null, async () => ({
          text: await call(args as Record<string, unknown>),
          reusable: false,
        })),
    });
    const tools = await withRepeatingGoalsPinned(
      initiator,
      ownerId,
      async (bot) => [
        // What the Routines app's transport calls (`builtin-routines.ts`).
        ...GOAL_TOOLS.map((goalTool) =>
          appTool(goalTool.name, (args) =>
            callGoalTool(
              { ownerUserId: ownerId, agentId: bot },
              goalTool.name,
              args,
            ),
          ),
        ),
        // What `update_routine` with `enabled: false` calls.
        appTool("update_routine", async ({ id }) => {
          await routineStore.update(ownerId, String(id), { enabled: false });
          return "Switched off.";
        }),
      ],
    )(botId);
    return (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${name} missing`);
      return withApprovalContext(
        {
          runId,
          threadId: `${prefix}-thread`,
          toolCallId: randomUUID(),
          toolName: name,
          args,
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
          initiator,
        },
        () => tool.execute(args),
      );
    };
  }

  test("a routine's turn switches off or deletes its goal's routine, and still can't complete it", async () => {
    for (const change of ["switch off", "delete"] as const) {
      const goal = await store.create(ownerId, valid);
      const routineId = await routineRunning(goal.id);
      const call = await turnBegins({ kind: "routine", id: routineId });
      // What `update_routine` with `enabled: false`, and `delete_routine`, call.
      if (change === "switch off")
        await routineStore.update(ownerId, routineId, { enabled: false });
      else await routineStore.remove(ownerId, routineId);
      expect(await store.repeats(ownerId, goal.id)).toBeNull();
      expect(await call("complete_goal", { id: goal.id })).toStartWith(
        "Refused. This goal repeated when this run began",
      );
      expect((await store.get(ownerId, goal.id)).status).toBe("active");
    }
  });

  test("a routine's turn switches off its goal's routine beside completing it, and still can't", async () => {
    const goal = await store.create(ownerId, valid);
    const routineId = await routineRunning(goal.id);
    const call = await turnBegins({ kind: "routine", id: routineId });
    // Both in one step: `complete_goal` waits behind `update_routine`, and runs once it is done.
    const [, ended] = await Promise.all([
      call("update_routine", { id: routineId }),
      call("complete_goal", { id: goal.id }),
    ]);
    expect(await routineEnabled(routineId)).toBe(false);
    expect(ended).toStartWith(
      "Refused. This goal repeated when this run began",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("active");
  });

  test("a routine's turn pauses or deletes its goal's trigger, and still can't complete it", async () => {
    for (const change of ["pause", "delete"] as const) {
      const goal = await store.create(ownerId, valid);
      const { trigger } = await triggers.create(ownerId, goal.id, {
        config: { kind: "webhook", filter: { eventTypes: ["release"] } },
      });
      const call = await turnBegins({ kind: "routine", id: "a-routine" });
      // What `pause_trigger` and `delete_trigger` call.
      if (change === "pause")
        await triggers.setEnabled(ownerId, trigger.id, false);
      else await triggers.remove(ownerId, trigger.id);
      expect(await store.repeats(ownerId, goal.id)).toBeNull();
      expect(await call("complete_goal", { id: goal.id })).toStartWith(
        "Refused. This goal repeated when this run began",
      );
      expect((await store.get(ownerId, goal.id)).status).toBe("active");
    }
  });

  test("the person's turn still ends a goal its routine runs, and the routine is switched off", async () => {
    const goal = await store.create(ownerId, valid);
    const routineId = await routineRunning(goal.id);
    const call = await turnBegins({ kind: "person" });
    expect(await call("complete_goal", { id: goal.id })).not.toStartWith(
      "Refused.",
    );
    expect((await store.get(ownerId, goal.id)).status).toBe("completed");
    expect(await routineEnabled(routineId)).toBe(false);
  });

  test("a routine's turn still completes a goal that did not repeat when the turn began", async () => {
    const once = await store.create(ownerId, valid);
    // Its routine was switched off before this turn began.
    const before = await store.create(ownerId, valid);
    const routineId = await routineRunning(before.id);
    await routineStore.update(ownerId, routineId, { enabled: false });
    const call = await turnBegins({ kind: "routine", id: "a-routine" });
    for (const goal of [once, before]) {
      expect(await call("complete_goal", { id: goal.id })).not.toStartWith(
        "Refused.",
      );
      expect((await store.get(ownerId, goal.id)).status).toBe("completed");
    }
  });
});

describe("the person", () => {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: ownerId,
      email: `${ownerId}@example.test`,
      role: "user",
    } as never);
    await next();
  };
  const app = new Hono().route(
    "/api/responsibilities",
    createResponsibilityRoutes(store, engine, signedIn),
  );
  async function patch(id: string, body: Record<string, unknown>) {
    return app.request(`/api/responsibilities/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("still changes whether a goal repeats and what ends it, while a run of it works", async () => {
    const { goal } = await inRun(
      {
        recurring: true,
        subscriptions: [{ source: "github", eventType: "release.published" }],
      },
      true,
    );
    expect(
      (
        await patch(goal.id, {
          recurring: false,
          subscriptions: [],
          successCriteria: "",
        })
      ).status,
    ).toBe(200);
    const blanked = await store.get(ownerId, goal.id);
    expect(blanked.recurring).toBe(false);
    expect(blanked.subscriptions).toEqual([]);
    expect(blanked.successCriteria).toBe("");
    // A goal that ends when met says what done looks like (`ENDS_WITHOUT_OUTCOME`), for the person too.
    expect(
      (
        await patch(goal.id, {
          endsWhenMet: true,
          successCriteria: "The release is summarised.",
        })
      ).status,
    ).toBe(200);
    const after = await store.get(ownerId, goal.id);
    expect(after.endsWhenMet).toBe(true);
    expect(after.successCriteria).toBe("The release is summarised.");
  });
  test("still completes a goal that repeated, after a run of it switched off its routine", async () => {
    const { goal, routineId, call } = await inRun({}, true);
    if (!routineId) throw new Error("Expected a routine.");
    await routineStore.update(ownerId, routineId, { enabled: false });
    expect(await call("complete_goal", { id: goal.id })).toStartWith(
      "Refused.",
    );
    const response = await app.request(
      `/api/responsibilities/${goal.id}/complete`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect((await store.get(ownerId, goal.id)).status).toBe("completed");
  });
});
