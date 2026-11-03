import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count, eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  channels,
  intelligenceChannelMappings,
  routineRuns,
  routines,
  users,
} from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { removeBots, useTestBots } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  purgeRoutinesOwnedBy,
  storedRoutine,
  useTestSchedules,
} from "./support/schedules";
import { sourceFiles, stripComments } from "./support/source-scan";

/**
 * Routines and their runs live in Intelligence now. The local `routines` and `routine_runs` tables
 * stay one release for the upgrade copy and must receive nothing: a write that still landed there
 * would be a routine Intelligence never heard of, firing for nobody or failing to fire for somebody.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owners: string[] = [];
const bots: string[] = [];
const channelIds: string[] = [];

afterAll(async () => {
  for (const owner of owners) await purgeRoutinesOwnedBy(owner);
  for (const channelId of channelIds) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  await removeBots(bots);
  await database.delete(users).where(inArray(users.id, owners));
  await database.$client.close();
});

async function tableCounts() {
  const [routineRows] = await database
    .select({ total: count() })
    .from(routines);
  const [runRows] = await database.select({ total: count() }).from(routineRuns);
  return { routines: routineRows?.total, runs: runRows?.total };
}

describe("the legacy routine tables", () => {
  test("no server source names them except the upgrade copy and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set(["routines/upgrade.ts", "db/schema/coworker.ts"]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return /\broutineRuns\b|import \{[^}]*\broutines\b[^}]*\} from "[./]+db\/schema/.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a routine's whole life through the store writes nothing to them", async () => {
    await useTestBots();
    await useTestSchedules();
    const owner = `routines-no-local-writes-${randomUUID()}`;
    owners.push(owner);
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
    const actor = { id: owner, role: "user" as const };
    const profiles = createAgentProfileStore(
      database,
      new URL("https://managed.example.test/ag-ui"),
    );
    const bot = await profiles.create(actor, {
      name: "Standup",
      title: "Standup",
      roleDescription: "Posts the standup.",
      visibility: "private",
    });
    bots.push(bot.id);
    const channel = await createChannelStore(
      database,
      profiles,
      createThreadIdentity("test-deployment"),
    ).create(actor, [bot.id]);
    channelIds.push(channel.id);
    const store = createRoutineStore(database);
    const before = await tableCounts();

    const routine = await store.create({
      ownerUserId: owner,
      agentId: bot.id,
      channelId: channel.id,
      instruction: "Post the standup.",
      cron: "0 9 * * 1-5",
    });
    await store.update(owner, routine.id, { instruction: "Post it early." });
    await store.setEnabled(owner, routine.id, false);
    await store.setEnabled(owner, routine.id, true);
    const { runId } = await store.startManualRun(owner, routine.id);
    await store.finishRun(runId, "succeeded");
    await store.listRuns(owner, routine.id);
    await store.listFor(owner);
    await store.remove(owner, routine.id);

    expect(await tableCounts()).toEqual(before);
    const held = await storedRoutine(routine.id);
    expect(held.instruction).toBe("Post it early.");
    expect(held.deletedAt).toBeInstanceOf(Date);
  });
});
