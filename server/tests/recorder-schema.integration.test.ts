import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
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
