import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { ROUTINE_FIRE_KIND } from "../src/routines/sweep";
import { removeBots, testIntelligence, useTestBots } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import {
  changeRoutine,
  purgeRoutinesOwnedBy,
  runsOf,
  useTestSchedules,
} from "./support/schedules";

/**
 * A scheduled routine fires on time, exactly once, with two OpenBot processes sweeping at once.
 *
 * Two real OS processes, each the routines worker a deployment runs every minute
 * (`scripts/fire-routines.ts`), each with its own copy of the routines read from Intelligence at start,
 * on one OpenBot database and one Intelligence. The routines are due when both start. Each process
 * reports what it offered, which is how the test knows both really saw them due and raced, rather
 * than one finishing before the other looked. The two guarantees between them are the `routine.fire`
 * work item's key (routine and minute, a primary key) and Intelligence's compare-and-set on the
 * routine's clock; this proves they still hold now that the clock lives in Intelligence.
 */

const SERVER_DIR = resolve(import.meta.dir, "..");
const RECEIVER_PORT = 7590;
const SECRET = `routine-two-processes-${randomUUID()}`;
const ROUTINES = 4;
const GRACE_MS = 10 * 60_000;

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const store = createRoutineStore(database);
const prefix = `two-processes-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** Every dispatch a worker made: the run it named, when it arrived, and whose secret it carried. */
const dispatched: { routineRunId: string; at: number }[] = [];
let receiver: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  await useTestBots();
  await useTestSchedules();
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: RECEIVER_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        url.pathname !== "/internal/routines/run" ||
        request.headers.get("authorization") !== `Bearer ${SECRET}`
      )
        return new Response("no", { status: 401 });
      const body = (await request.json()) as { routineRunId: string };
      dispatched.push({ routineRunId: body.routineRunId, at: Date.now() });
      return new Response(null, { status: 202 });
    },
  });
});

afterAll(async () => {
  receiver?.stop(true);
  for (const userId of createdUserIds) await purgeRoutinesOwnedBy(userId);
  await database
    .delete(workItems)
    .where(
      and(
        eq(workItems.kind, ROUTINE_FIRE_KIND),
        like(workItems.key, "routine_%"),
      ),
    );
  for (const channelId of createdChannelIds) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  await removeBots(createdAgentIds);
  for (const userId of createdUserIds)
    await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

async function owner(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Two Processes",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

/** Routines due `dueAgoMs` ago, each its own person's, so no cap or channel is shared. */
async function dueRoutines(count: number, dueAgoMs: number) {
  const due = new Date(Date.now() - dueAgoMs);
  const made: { id: string; nextRunAt: Date }[] = [];
  for (let index = 0; index < count; index += 1) {
    const person = await owner();
    const bot = await profileStore.create(person, {
      name: "Standup",
      title: "Standup",
      roleDescription: "Posts the standup.",
      visibility: "private",
    });
    createdAgentIds.push(bot.id);
    const channel = await channelStore.create(person, [bot.id]);
    createdChannelIds.push(channel.id);
    const routine = await store.create({
      ownerUserId: person.id,
      agentId: bot.id,
      channelId: channel.id,
      instruction: `Post the standup summary ${index}.`,
      cron: "0 9 * * *",
    });
    const moved = await changeRoutine(routine.id, { nextRunAt: due });
    made.push({ id: routine.id, nextRunAt: moved.nextRunAt });
  }
  return made;
}

type WorkerReport = { offered: string[]; fired: string[]; exitCode: number };

/** One routines worker, as a deployment runs it, as its own OS process. */
async function worker(): Promise<WorkerReport> {
  const intelligence = testIntelligence();
  const child = Bun.spawn(["bun", "scripts/fire-routines.ts"], {
    cwd: SERVER_DIR,
    // The worker's own settings and nothing of this test process's environment beyond what runs a
    // program: whatever else the shell running the suite holds is not the deployment's.
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...testEnvironment({
        DATABASE_URL: testDatabaseUrl(),
        INTELLIGENCE_API_URL: intelligence.apiUrl,
        INTELLIGENCE_API_KEY: intelligence.apiKey,
        INTELLIGENCE_GATEWAY_WS_URL: intelligence.gatewayWsUrl,
        WORKER_SHARED_SECRET: SECRET,
        SERVER_INTERNAL_URL: `http://127.0.0.1:${RECEIVER_PORT}`,
      }),
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const report = `${stdout}\n${stderr}`
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          offered?: string[];
          fired?: string[];
        };
        return parsed.type === "routine-sweep" ? [parsed] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
  if (exitCode !== 0 || !report)
    throw new Error(
      `the routines worker exited ${exitCode} without its sweep report:\n${stdout}\n${stderr}`,
    );
  return {
    offered: report.offered ?? [],
    fired: report.fired ?? [],
    exitCode,
  };
}

describe("a routine due while two OpenBot processes sweep", () => {
  test("fires on time, exactly once", async () => {
    // Both processes must have seen the routines due for the race to be real. They start together,
    // but a process that boots slowly may look only after the other moved every clock; then the
    // round proves nothing about contention and another is run, with new routines.
    let raced = false;
    for (let round = 0; round < 4 && !raced; round += 1) {
      dispatched.length = 0;
      const routines = await dueRoutines(ROUTINES, 5_000);
      const ids = new Set(routines.map((routine) => routine.id));
      const started = Date.now();

      const [first, second] = await Promise.all([worker(), worker()]);

      const firstSaw = first.offered.filter((id) => ids.has(id));
      const secondSaw = second.offered.filter((id) => ids.has(id));
      raced = firstSaw.some((id) => secondSaw.includes(id));

      for (const routine of routines) {
        // Exactly one run in Intelligence for the firing, whatever both processes did.
        const runs = await runsOf(routine.id);
        expect(runs).toHaveLength(1);
        const [run] = runs;
        // Exactly one dispatch, of that run.
        const calls = dispatched.filter(
          (call) => call.routineRunId === run?.id,
        );
        expect(calls).toHaveLength(1);
        // On time: handed to the server within the grace window of when it was due, and within
        // seconds of the sweep that found it due.
        const call = calls[0];
        expect(call).toBeDefined();
        if (!call) continue;
        expect(call.at - routine.nextRunAt.getTime()).toBeLessThan(GRACE_MS);
        expect(call.at - started).toBeLessThan(60_000);
        // One firing on the queue, keyed on the minute it was due.
        const firings = await database
          .select()
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, ROUTINE_FIRE_KIND),
              like(workItems.key, `${routine.id}:%`),
            ),
          );
        expect(firings).toHaveLength(1);
        expect(firings[0]?.key).toBe(
          `${routine.id}:${routine.nextRunAt.toISOString().slice(0, 16)}Z`,
        );
        // And the clock moved once, past the occurrence that fired.
        const after = await (await useTestSchedules()).client.get(
          "routines",
          routine.id,
        );
        expect(after?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
        expect(after?.lastRunAt?.getTime()).toBe(routine.nextRunAt.getTime());
      }
      // Every one of these routines was handed over once: no more, no fewer.
      const theirRuns = new Set(
        (await Promise.all(routines.map((routine) => runsOf(routine.id))))
          .flat()
          .map((run) => run.id),
      );
      expect(
        dispatched.filter((call) => theirRuns.has(call.routineRunId)),
      ).toHaveLength(ROUTINES);
    }
    expect(raced).toBe(true);
  }, 240_000);
});
