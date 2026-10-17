import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import {
  demonstrationMedia,
  demonstrationMediaChunks,
  demonstrationSteps,
  demonstrations,
  demonstrationTrajectories,
} from "../src/db/schema/demonstrations";
import { skills } from "../src/db/schema/plugins";
import {
  recorderConnectCodes,
  recorderConnections,
} from "../src/db/schema/recorder";
import { skillShareRequests } from "../src/db/schema/skill-shares";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
const bot = `${prefix}-bot`;
const slug = `rec-${randomUUID().slice(0, 8)}`;
const skillId = `${prefix}-skill`;
let counter = 0;
const next = () => `${prefix}-${counter++}`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let message = "";
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    message = `${String(error)} ${String(cause ?? "")} ${JSON.stringify(error)}`;
  }
  expect(message).toMatch(pattern);
}

function demo(
  owner: string,
  overrides: Partial<typeof demonstrations.$inferInsert> = {},
) {
  return {
    id: next(),
    ownerUserId: owner,
    botId: bot,
    title: "Recording",
    status: "recording" as const,
    ...overrides,
  };
}

function connection(
  userId: string,
  overrides: Partial<typeof recorderConnections.$inferInsert> = {},
) {
  return {
    id: next(),
    userId,
    tokenHash: next(),
    label: "Chrome",
    via: "web" as const,
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    installId: next(),
    ...overrides,
  };
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: alice, email: `${alice}@example.test` },
    { id: bob, email: `${bob}@example.test` },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: "Recorder Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: alice,
    title: "Recorder Bot",
    roleDescription: "Assist",
    avatarSeed: bot,
    visibility: "private",
  });
  await database.insert(skills).values({
    id: skillId,
    ownerUserId: alice,
    slug,
    title: "Recorded",
    summary: "Recorded skill",
    instructions: "Do it",
  });
});

afterAll(async () => {
  await database.delete(skills).where(eq(skills.slug, slug));
  await database.delete(users).where(inArray(users.id, [alice, bob]));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.$client.close();
});

test("a demonstration defaults to the cloud browser with no steps", async () => {
  const id = next();
  await database
    .insert(demonstrations)
    .values(demo(alice, { id, status: "stopped" }));
  const [row] = await database
    .select()
    .from(demonstrations)
    .where(eq(demonstrations.id, id));
  expect(row?.source).toBe("computer");
  expect(row?.stepCount).toBe(0);
});

test("recording slots: one cloud recording per Bot, one extension recording per person and Bot", async () => {
  const bot2 = `${prefix}-bot2`;
  await database
    .insert(agents)
    .values({ id: bot2, name: "Other", type: "built_in", configuration: {} });
  try {
    const cloud = demo(alice, { botId: bot2, source: "computer" });
    await database.insert(demonstrations).values(cloud);
    await rejects(
      database
        .insert(demonstrations)
        .values(demo(bob, { botId: bot2, source: "computer" })),
      /demonstrations_active_bot_idx/,
    );
    await database
      .insert(demonstrations)
      .values(demo(alice, { botId: bot2, source: "extension" }));
    await database
      .insert(demonstrations)
      .values(demo(bob, { botId: bot2, source: "extension" }));
    await rejects(
      database
        .insert(demonstrations)
        .values(demo(alice, { botId: bot2, source: "extension" })),
      /demonstrations_active_extension_idx/,
    );
  } finally {
    await database.delete(agents).where(eq(agents.id, bot2));
  }
});

test("deleting a demonstration removes its trajectories, steps, media and chunks", async () => {
  const value = demo(alice, { status: "stopped", source: "extension" });
  await database.insert(demonstrations).values(value);
  await database.insert(demonstrationTrajectories).values({
    trajectoryId: randomUUID(),
    demonstrationId: value.id,
    ownerUserId: alice,
  });
  await database.insert(demonstrationSteps).values({
    demonstrationId: value.id,
    index: 0,
    action: { kind: "click" },
  });
  const mediaId = randomUUID();
  await database.insert(demonstrationMedia).values({
    id: mediaId,
    demonstrationId: value.id,
    ownerUserId: alice,
    kind: "screen",
    mimeType: "video/webm",
  });
  await database
    .insert(demonstrationMediaChunks)
    .values({ mediaId, index: 0, bytes: Buffer.from([1, 2, 3]) });
  await database.delete(demonstrations).where(eq(demonstrations.id, value.id));
  for (const [table, column, key] of [
    [
      demonstrationTrajectories,
      demonstrationTrajectories.demonstrationId,
      value.id,
    ],
    [demonstrationSteps, demonstrationSteps.demonstrationId, value.id],
    [demonstrationMedia, demonstrationMedia.demonstrationId, value.id],
    [demonstrationMediaChunks, demonstrationMediaChunks.mediaId, mediaId],
  ] as const) {
    expect(await database.select().from(table).where(eq(column, key))).toEqual(
      [],
    );
  }
});

test("a 3 MiB chunk round-trips byte for byte", async () => {
  const value = demo(alice, { status: "stopped", source: "extension" });
  await database.insert(demonstrations).values(value);
  const mediaId = randomUUID();
  await database.insert(demonstrationMedia).values({
    id: mediaId,
    demonstrationId: value.id,
    ownerUserId: alice,
    kind: "audio",
    mimeType: "audio/webm",
  });
  const bytes = randomBytes(3 * 1024 * 1024);
  await database
    .insert(demonstrationMediaChunks)
    .values({ mediaId, index: 0, bytes });
  const [row] = await database
    .select()
    .from(demonstrationMediaChunks)
    .where(eq(demonstrationMediaChunks.mediaId, mediaId));
  expect(Buffer.compare(row?.bytes as Buffer, bytes)).toBe(0);
});

test("a media row's kind must be screen, audio or network", async () => {
  const value = demo(alice, { status: "stopped", source: "extension" });
  await database.insert(demonstrations).values(value);
  const base = {
    demonstrationId: value.id,
    ownerUserId: alice,
    mimeType: "x/y",
  };
  await database.insert(demonstrationMedia).values({ ...base, kind: "audio" });
  await rejects(
    database
      .insert(demonstrationMedia)
      .values({ ...base, kind: "video" as "audio" }),
    /demonstration_media_kind_check/,
  );
});

test("a trajectory's learning state is one of the known states", async () => {
  const value = demo(alice, { status: "stopped", source: "extension" });
  await database.insert(demonstrations).values(value);
  for (const learningState of [
    "missing",
    "learning-off",
    "unjoined",
  ] as const) {
    await database.insert(demonstrationTrajectories).values({
      trajectoryId: randomUUID(),
      demonstrationId: value.id,
      ownerUserId: alice,
      learningState,
    });
  }
  await rejects(
    database.insert(demonstrationTrajectories).values({
      trajectoryId: randomUUID(),
      demonstrationId: value.id,
      ownerUserId: alice,
      learningState: "lost" as "missing",
    }),
    /demonstration_trajectories_learning_state_check/,
  );
});

test("demonstration steps are keyed by demonstration and index", async () => {
  const value = demo(alice, { status: "stopped", source: "extension" });
  await database.insert(demonstrations).values(value);
  const step = {
    demonstrationId: value.id,
    index: 0,
    action: { kind: "click" },
  };
  await database.insert(demonstrationSteps).values(step);
  await database.insert(demonstrationSteps).values({ ...step, index: 1 });
  await rejects(
    database.insert(demonstrationSteps).values(step),
    /demonstration_steps_demonstration_id_index_pk|duplicate key|unique/i,
  );
  await database.delete(demonstrations).where(eq(demonstrations.id, value.id));
  expect(
    await database
      .select()
      .from(demonstrationSteps)
      .where(eq(demonstrationSteps.demonstrationId, value.id)),
  ).toEqual([]);
});

test("the trajectory foreign key keeps its short name", async () => {
  const names = await database.execute(
    sql`select conname from pg_constraint where conrelid = 'demonstration_trajectories'::regclass and contype = 'f'`,
  );
  const list = (names as unknown as { conname: string }[]).map(
    (row) => row.conname,
  );
  expect(list).toContain("demonstration_trajectories_demonstration_fk");
  expect(list).toContain(
    "demonstration_trajectories_owner_user_id_users_id_fk",
  );
  const migration = await Bun.file(
    new URL("../drizzle/0057_recorder_extension.sql", import.meta.url),
  ).text();
  const quoted = [...migration.matchAll(/"([a-z0-9_]+)"/g)].map(
    (match) => match[1] as string,
  );
  for (const name of quoted) expect(name.length).toBeLessThanOrEqual(63);
});

test("a connection token hash is unique", async () => {
  const tokenHash = next();
  await database
    .insert(recorderConnections)
    .values(connection(alice, { tokenHash }));
  await rejects(
    database.insert(recorderConnections).values(connection(bob, { tokenHash })),
    /token_hash|unique/i,
  );
});

test("one live connection per person and installed copy", async () => {
  const installId = next();
  await database
    .insert(recorderConnections)
    .values(connection(alice, { installId }));
  await rejects(
    database
      .insert(recorderConnections)
      .values(connection(alice, { installId })),
    /recorder_connections_live_install_idx/,
  );
  await database
    .insert(recorderConnections)
    .values(connection(alice, { installId, revokedAt: new Date() }));
  await database.insert(recorderConnections).values(connection(alice));
});

test("deleting a person removes their connections and connect codes", async () => {
  const carol = `${prefix}-carol`;
  await database
    .insert(users)
    .values({ id: carol, email: `${carol}@example.test` });
  await database.insert(recorderConnections).values(connection(carol));
  await database.insert(recorderConnectCodes).values({
    codeHash: next(),
    userId: carol,
    via: "desktop",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await database.delete(users).where(eq(users.id, carol));
  expect(
    await database
      .select()
      .from(recorderConnections)
      .where(eq(recorderConnections.userId, carol)),
  ).toEqual([]);
  expect(
    await database
      .select()
      .from(recorderConnectCodes)
      .where(eq(recorderConnectCodes.userId, carol)),
  ).toEqual([]);
});

test("skill-share requests: one pending per kind and Skill, and a make_bot row names its Bot", async () => {
  const share = (kind: "share" | "make_bot", status = "pending") => ({
    id: next(),
    kind,
    skillSlug: slug,
    requestedBy: alice,
    status: status as "pending",
    ...(kind === "make_bot"
      ? { botName: "Bot", botTitle: "Title", botRoleDescription: "Role" }
      : {}),
  });
  await database.insert(skillShareRequests).values(share("share"));
  await rejects(
    database.insert(skillShareRequests).values(share("share")),
    /skill_share_requests_pending_idx/,
  );
  await database.insert(skillShareRequests).values(share("make_bot"));
  await database.insert(skillShareRequests).values(share("share", "declined"));
  await rejects(
    database
      .insert(skillShareRequests)
      .values({ ...share("make_bot", "declined"), botName: null }),
    /skill_share_requests_bot_check/,
  );
});
