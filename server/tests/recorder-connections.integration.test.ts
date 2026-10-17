import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  recorderConnectCodes,
  recorderConnections,
} from "../src/db/schema/recorder";
import { createRecorderConnectionStore } from "../src/recorder/connections";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `recorder-connections-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createRecorderConnectionStore(database);
const CHROME = "c".repeat(32); // an install id (Decision 18): 32 lowercase hex digits
const EDGE = "e".repeat(32);

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

async function connect(installId: string, label = "Chrome on macOS") {
  const { code } = await store.mintCode(owner, "web");
  const made = await store.exchange({
    code,
    label,
    extensionId: RECORDER_EXTENSION_ID,
    installId,
  });
  if (!made) throw new Error("the exchange was refused");
  return made;
}

test("a connect code works once and yields a token that resolves to its person", async () => {
  const { code } = await store.mintCode(owner, "web");
  const first = await store.exchange({
    code,
    label: "Chrome on macOS",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  expect(first?.userId).toBe(owner);
  expect(first?.token).toMatch(/^obr_[A-Za-z0-9_-]{43}$/);
  expect(code).toMatch(/^obc_[A-Za-z0-9_-]{43}$/);
  expect(
    await store.exchange({
      code,
      label: "again",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
  expect(await store.resolve(first!.token)).toEqual({
    connectionId: first!.connection.id,
    userId: owner,
    organizationSession: null,
  });
});

test("an expired code is refused", async () => {
  const late = createRecorderConnectionStore(database, {
    now: () => new Date(Date.now() + 6 * 60_000),
  });
  const { code } = await store.mintCode(owner, "web");
  expect(
    await late.exchange({
      code,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
});

test("an unknown code is refused", async () => {
  expect(
    await store.exchange({
      code: `obc_${"A".repeat(43)}`,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: CHROME,
    }),
  ).toBeNull();
});

test("only digests are stored", async () => {
  const { code } = await store.mintCode(owner, "desktop");
  const made = await store.exchange({
    code,
    label: "Edge on Windows",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  const rows = await database
    .select()
    .from(recorderConnections)
    .where(eq(recorderConnections.userId, owner));
  expect(JSON.stringify(rows)).not.toContain(made!.token);
  expect(
    JSON.stringify(await database.select().from(recorderConnectCodes)),
  ).not.toContain(code);
});

test("an organization session travels from the code to the connection", async () => {
  const { code } = await store.mintCode(owner, "web", "sealed-value");
  const made = await store.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  expect((await store.resolve(made!.token))?.organizationSession).toBe(
    "sealed-value",
  );
});

test("a revoked connection stops resolving and leaves the list", async () => {
  const made = await connect(EDGE);
  expect(await store.revoke(owner, made.connection.id)).toBe(true);
  expect(await store.resolve(made.token)).toBeNull();
  expect((await store.list(owner)).map((c) => c.id)).not.toContain(
    made.connection.id,
  );
});

test("last use is recorded at most once a minute", async () => {
  let now = new Date();
  const clocked = createRecorderConnectionStore(database, { now: () => now });
  const { code } = await clocked.mintCode(owner, "web");
  const made = await clocked.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: CHROME,
  });
  const lastUsed = async () =>
    (
      await database
        .select({ at: recorderConnections.lastUsedAt })
        .from(recorderConnections)
        .where(eq(recorderConnections.id, made!.connection.id))
    )[0]?.at;
  expect(await lastUsed()).toBeNull();
  const first = now;
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(first.getTime());
  now = new Date(first.getTime() + 10_000);
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(first.getTime());
  now = new Date(first.getTime() + 61_000);
  await clocked.resolve(made!.token);
  expect((await lastUsed())?.getTime()).toBe(now.getTime());
});

test("revoking someone else's connection does nothing", async () => {
  const made = await connect(CHROME);
  expect(await store.revoke(other, made.connection.id)).toBe(false);
  expect(await store.resolve(made.token)).not.toBeNull();
});

test("the same copy connecting again replaces its older connection; another copy does not", async () => {
  const first = await connect(CHROME, "Chrome");
  const edge = await connect(EDGE, "Edge");
  const again = await connect(CHROME, "Chrome");
  expect(again.replaced).toBe(first.connection.id);
  expect(edge.replaced).toBeNull();
  expect(await store.resolve(first.token)).toBeNull();
  expect(await store.resolve(edge.token)).not.toBeNull();
  expect((await store.list(owner)).map((c) => c.installId).sort()).toEqual([
    CHROME,
    EDGE,
  ]);
});
