import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  learningOpenSkills,
  learningPersonSpaces,
  learningSkillSharing,
} from "../src/db/schema/learning";
import {
  recorderConnectCodes,
  recorderConnections,
  recorderTrajectoryBindings,
} from "../src/db/schema/recorder";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-${randomUUID()}`;
const alice = `${prefix}-alice`;
const bob = `${prefix}-bob`;
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
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [alice, bob]));
  await database.$client.close();
});

test("no name in the migration is longer than PostgreSQL keeps", async () => {
  const migration = await Bun.file(
    new URL("../drizzle/0066_recorder_extension.sql", import.meta.url),
  ).text();
  const quoted = [...migration.matchAll(/"([a-z0-9_]+)"/g)].map(
    (match) => match[1] as string,
  );
  expect(quoted.length).toBeGreaterThan(0);
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

test("a trajectory binds to one person, by its UUID, and names no Bot", async () => {
  const trajectoryId = randomUUID();
  await database
    .insert(recorderTrajectoryBindings)
    .values({ trajectoryId, userId: alice });
  await rejects(
    database
      .insert(recorderTrajectoryBindings)
      .values({ trajectoryId, userId: bob }),
    /recorder_trajectory_bindings_pkey|duplicate key/i,
  );
  await rejects(
    database
      .insert(recorderTrajectoryBindings)
      .values({ trajectoryId: "not-a-uuid", userId: alice }),
    /uuid/i,
  );
  const [row] = await database
    .select()
    .from(recorderTrajectoryBindings)
    .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId));
  expect(row).toMatchObject({ trajectoryId, userId: alice });
  expect(Object.keys(row ?? {}).sort()).toEqual([
    "createdAt",
    "trajectoryId",
    "userId",
  ]);
  expect(row?.createdAt).toBeInstanceOf(Date);
  const columns = (await database.execute(
    sql`select column_name from information_schema.columns where table_name = 'recorder_trajectory_bindings' order by column_name`,
  )) as unknown as { column_name: string }[];
  expect(columns.map((column) => column.column_name)).toEqual([
    "created_at",
    "trajectory_id",
    "user_id",
  ]);
});

test("deleting a person removes their trajectory bindings, Learning space row and sharing choice", async () => {
  const dave = `${prefix}-dave`;
  await database
    .insert(users)
    .values({ id: dave, email: `${dave}@example.test` });
  await database
    .insert(recorderTrajectoryBindings)
    .values({ trajectoryId: randomUUID(), userId: dave });
  await database
    .insert(learningPersonSpaces)
    .values({ userId: dave, containerId: `${prefix}-space-dave` });
  await database
    .insert(learningSkillSharing)
    .values({ userId: dave, mode: "choose" });
  await database
    .insert(learningOpenSkills)
    .values({ userId: dave, skillName: "refund-order" });
  await database.delete(users).where(eq(users.id, dave));
  for (const table of [
    recorderTrajectoryBindings,
    learningPersonSpaces,
    learningSkillSharing,
    learningOpenSkills,
  ]) {
    expect(
      await database.select().from(table).where(eq(table.userId, dave)),
    ).toEqual([]);
  }
});

test("a sharing choice is closed, open or choose, and closed by default", async () => {
  await database.insert(learningSkillSharing).values({ userId: alice });
  const [row] = await database
    .select()
    .from(learningSkillSharing)
    .where(eq(learningSkillSharing.userId, alice));
  expect(row?.mode).toBe("closed");
  await rejects(
    database
      .update(learningSkillSharing)
      .set({ mode: "everyone" as never })
      .where(eq(learningSkillSharing.userId, alice)),
    /learning_skill_sharing_mode_check|check constraint/i,
  );
  await database
    .delete(learningSkillSharing)
    .where(eq(learningSkillSharing.userId, alice));
});

test("one Learning space per person, and no two people share one", async () => {
  const space = `${prefix}-space`;
  await database
    .insert(learningPersonSpaces)
    .values({ userId: alice, containerId: space });
  await rejects(
    database
      .insert(learningPersonSpaces)
      .values({ userId: alice, containerId: `${space}-2` }),
    /learning_person_spaces_pkey|duplicate key/i,
  );
  await rejects(
    database
      .insert(learningPersonSpaces)
      .values({ userId: bob, containerId: space }),
    /learning_person_spaces_container_id_unique|duplicate key/i,
  );
  await database
    .delete(learningPersonSpaces)
    .where(eq(learningPersonSpaces.userId, alice));
});

test("the migration holds only the Recorder's connections and trajectory bindings, and each person's Learning space and sharing", async () => {
  const migration = await Bun.file(
    new URL("../drizzle/0066_recorder_extension.sql", import.meta.url),
  ).text();
  const created = [...migration.matchAll(/CREATE TABLE "([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
  expect(created.sort()).toEqual([
    "learning_open_skills",
    "learning_person_spaces",
    "learning_skill_sharing",
    "recorder_connect_codes",
    "recorder_connections",
    "recorder_trajectory_bindings",
  ]);
  expect(migration).not.toMatch(/ALTER TABLE "demonstrations"|DROP /);
  // A recording is the person's: no Bot column, and no reference to the agents table.
  expect(migration).not.toMatch(/bot_id|"agents"/);
});
