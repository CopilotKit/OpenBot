import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
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
const botOne = `${prefix}-bot-1`;
const botTwo = `${prefix}-bot-2`;
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
  await database.insert(agents).values(
    [botOne, botTwo].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
});

afterAll(async () => {
  await database.delete(agents).where(inArray(agents.id, [botOne, botTwo]));
  await database.delete(users).where(inArray(users.id, [alice, bob]));
  await database.$client.close();
});

test("no name in the migration is longer than PostgreSQL keeps", async () => {
  const migration = await Bun.file(
    new URL("../drizzle/0057_recorder_extension.sql", import.meta.url),
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

test("a trajectory binds to one person and Bot, by its UUID", async () => {
  const trajectoryId = randomUUID();
  await database
    .insert(recorderTrajectoryBindings)
    .values({ trajectoryId, userId: alice, botId: botOne });
  await rejects(
    database
      .insert(recorderTrajectoryBindings)
      .values({ trajectoryId, userId: bob, botId: botTwo }),
    /recorder_trajectory_bindings_pkey|duplicate key/i,
  );
  await rejects(
    database
      .insert(recorderTrajectoryBindings)
      .values({ trajectoryId: "not-a-uuid", userId: alice, botId: botOne }),
    /uuid/i,
  );
  const [row] = await database
    .select()
    .from(recorderTrajectoryBindings)
    .where(eq(recorderTrajectoryBindings.trajectoryId, trajectoryId));
  expect(row).toMatchObject({ trajectoryId, userId: alice, botId: botOne });
  expect(row?.createdAt).toBeInstanceOf(Date);
});

test("deleting a person removes their trajectory bindings", async () => {
  const dave = `${prefix}-dave`;
  await database
    .insert(users)
    .values({ id: dave, email: `${dave}@example.test` });
  await database
    .insert(recorderTrajectoryBindings)
    .values({ trajectoryId: randomUUID(), userId: dave, botId: botOne });
  await database.delete(users).where(eq(users.id, dave));
  expect(
    await database
      .select()
      .from(recorderTrajectoryBindings)
      .where(eq(recorderTrajectoryBindings.userId, dave)),
  ).toEqual([]);
});

test("a binding names a Bot that exists, and deleting the Bot removes its bindings", async () => {
  await rejects(
    database.insert(recorderTrajectoryBindings).values({
      trajectoryId: randomUUID(),
      userId: alice,
      botId: `${prefix}-no-such-bot`,
    }),
    /bot_id|foreign key/i,
  );
  const gone = `${prefix}-bot-gone`;
  await database
    .insert(agents)
    .values({ id: gone, name: gone, type: "built_in", configuration: {} });
  await database
    .insert(recorderTrajectoryBindings)
    .values({ trajectoryId: randomUUID(), userId: alice, botId: gone });
  await database.delete(agents).where(eq(agents.id, gone));
  expect(
    await database
      .select()
      .from(recorderTrajectoryBindings)
      .where(eq(recorderTrajectoryBindings.botId, gone)),
  ).toEqual([]);
});

test("the migration holds only the Recorder's connections and trajectory bindings", async () => {
  const migration = await Bun.file(
    new URL("../drizzle/0057_recorder_extension.sql", import.meta.url),
  ).text();
  const created = [...migration.matchAll(/CREATE TABLE "([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
  expect(created.sort()).toEqual([
    "recorder_connect_codes",
    "recorder_connections",
    "recorder_trajectory_bindings",
  ]);
  expect(migration).not.toMatch(/ALTER TABLE "demonstrations"|DROP /);
});
