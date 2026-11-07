import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import { readToolName } from "@openbot/shared/tool-name";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { markUntrusted } from "../src/untrusted-content";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { responsibilityTools } from "../src/responsibilities/tools";
import { TRIGGER_TOOLS } from "../src/responsibilities/trigger-tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Every word a goal's run hands the model says goal.
 *
 * Every screen calls it a goal, and the model repeats the words its tools and its turn give it. A
 * goal's run on OpenBot Desktop was handed `complete_responsibility` and "a responsibility", and its
 * reply, "I've marked the responsibility complete", is what the person read in the conversation and
 * as the goal's Activity summary. These are the tools a goal's run is built with
 * (`responsibilities/wiring.ts`), the turn it is sent, and the real store's refusals as the tool
 * hands them back.
 */

const SAYS_RESPONSIBILITY = /responsibilit/i;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-words-${randomUUID()}`;
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
const toolsFor = (runId?: string) =>
  responsibilityTools({
    store,
    engine: { ingest: async () => ({}) as never },
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    ...(runId ? { responsibilityRunId: runId } : {}),
  });
const call = (name: string, args: unknown, runId?: string) => {
  const tool = toolsFor(runId).find((each) => each.name === name);
  if (!tool) throw new Error(`${name} is not one of a goal's tools`);
  return tool.execute(args);
};
const newGoal = () =>
  store.create(ownerId, {
    agentId: botId,
    channelId,
    title: "Save the heading",
    instruction: "Open example.com and save its heading to heading.txt",
    successCriteria: "heading.txt holds the page's heading",
    subscriptions: [],
  });

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Goal words Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ownerId]));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

describe("a goal's run", () => {
  test("is handed tools named and described as a goal", () => {
    // What the runner offers the model: the name, the description and the JSON schema.
    const offered = toolsFor().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    }));
    expect(offered.map((tool) => tool.name).sort()).toEqual(
      [
        "complete_goal",
        "create_goal",
        "list_goals",
        "pause_goal",
        "report_goal_progress",
        "resume_goal",
        "run_goal",
        "update_goal",
      ].sort(),
    );
    for (const tool of offered) {
      expect(JSON.stringify(tool)).not.toMatch(SAYS_RESPONSIBILITY);
      expect(tool.description).toMatch(/\bgoals?\b/);
    }
  });

  test("is sent a turn that names its goal and the goal's own progress tool", () => {
    const turn = buildResponsibilityTurn({
      instruction: "Open example.com and save its heading to heading.txt",
      successCriteria: "heading.txt holds the page's heading",
      progress: "",
      trigger: { source: "manual", type: "requested" },
      eventData: markUntrusted("{}", "manual event"),
      responsibilityId: "goal-1",
    });
    expect(turn).not.toMatch(SAYS_RESPONSIBILITY);
    expect(turn).toEndWith(
      "Record meaningful progress with report_goal_progress for goal goal-1.",
    );
  });

  test("reads every refusal as a goal's", async () => {
    const paused = await newGoal();
    await store.transition(ownerId, paused.id, "paused");
    const done = await newGoal();
    await store.transition(ownerId, done.id, "completed");
    const active = await newGoal();

    const refusals = [
      await call("report_goal_progress", { id: paused.id, summary: "Saved" }),
      await call("resume_goal", { id: done.id }),
      await call("pause_goal", { id: `${prefix}-nobody` }),
      await call(
        "report_goal_progress",
        { id: active.id, summary: "Saved" },
        `${prefix}-not-its-run`,
      ),
    ];
    expect(refusals).toEqual([
      "Refused. Only an active goal can make progress.",
      "Refused. A completed goal can't be resumed. Create a new goal.",
      "Refused. This goal could not be found.",
      "Refused. Progress must come from the goal's current run.",
    ]);
  });
});

describe("a goal's triggers, in a conversation", () => {
  test("are offered in a goal's words, pointing at the Goals page", () => {
    const offered = JSON.stringify(TRIGGER_TOOLS);
    expect(offered).not.toMatch(SAYS_RESPONSIBILITY);
    expect(offered).toContain("the Bot's Goals page");
  });
});

describe("a goal's steps in the conversation", () => {
  test("read as a goal, for the names a goal's tools have now and had before", () => {
    for (const name of [
      "complete_goal",
      "complete_responsibility",
      "create_goal",
      "create_responsibility",
      "run_goal",
      "run_responsibility",
    ]) {
      expect(readToolName(name).label).toMatch(/\bgoal\b/);
      expect(readToolName(name, true).label).toMatch(/\bgoal\b/);
    }
  });
});
