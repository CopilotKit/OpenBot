import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { and, eq, inArray } from "drizzle-orm";
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

/** Mints a code, failing the test when the store refuses one. */
async function mint(
  on: ReturnType<typeof createRecorderConnectionStore>,
  userId: string,
  via: "web" | "desktop",
  organizationSession: string | null = null,
) {
  const minted = await on.mintCode(userId, via, organizationSession);
  if (!minted) throw new Error("the store refused a connect code");
  return minted;
}

async function connect(installId: string, label = "Chrome on macOS") {
  const { code } = await mint(store, owner, "web");
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
  const { code } = await mint(store, owner, "web");
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
  const { code } = await mint(store, owner, "web");
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
  const { code } = await mint(store, owner, "desktop");
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
  const { code } = await mint(store, owner, "web", "sealed-value");
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
  const { code } = await mint(clocked, owner, "web");
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

const sessionOf = async (connectionId: string) =>
  (
    await database
      .select({ sealed: recorderConnections.organizationSession })
      .from(recorderConnections)
      .where(eq(recorderConnections.id, connectionId))
  )[0]?.sealed;

test("a used code is deleted with the organization session it held", async () => {
  const { code } = await mint(store, owner, "web", "sealed-once");
  const made = await store.exchange({
    code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(made).not.toBeNull();
  const kept = await database
    .select({ sealed: recorderConnectCodes.organizationSession })
    .from(recorderConnectCodes)
    .where(eq(recorderConnectCodes.userId, owner));
  expect(kept.map((row) => row.sealed)).not.toContain("sealed-once");
});

test("revoking a connection, or replacing it, drops its organization session", async () => {
  const revokedCode = await mint(store, owner, "web", "sealed-revoked");
  const revoked = await store.exchange({
    code: revokedCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(await sessionOf(revoked!.connection.id)).toBe("sealed-revoked");
  expect(await store.revoke(owner, revoked!.connection.id)).toBe(true);
  expect(await sessionOf(revoked!.connection.id)).toBeNull();

  const firstCode = await mint(store, owner, "web", "sealed-first");
  const first = await store.exchange({
    code: firstCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  const againCode = await mint(store, owner, "web", "sealed-again");
  const again = await store.exchange({
    code: againCode.code,
    label: "x",
    extensionId: RECORDER_EXTENSION_ID,
    installId: EDGE,
  });
  expect(again!.replaced).toBe(first!.connection.id);
  expect(await sessionOf(first!.connection.id)).toBeNull();
  expect(await sessionOf(again!.connection.id)).toBe("sealed-again");
});

test("minting a code deletes every expired one, with its organization session", async () => {
  await mint(store, other, "web", "sealed-expired");
  const late = createRecorderConnectionStore(database, {
    now: () => new Date(Date.now() + 6 * 60_000),
  });
  await mint(late, owner, "web");
  const expired = await database
    .select({ sealed: recorderConnectCodes.organizationSession })
    .from(recorderConnectCodes)
    .where(
      and(
        eq(recorderConnectCodes.userId, other),
        eq(recorderConnectCodes.organizationSession, "sealed-expired"),
      ),
    );
  expect(expired).toEqual([]);
});

test("a person holding ten unexpired codes is refused another until one is used or expires", async () => {
  const person = `${prefix}-busy`;
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  try {
    const codes = [];
    for (let index = 0; index < 10; index += 1) {
      codes.push(await mint(store, person, "web"));
    }
    expect(await store.mintCode(person, "web")).toBeNull();
    // Another person is not held back by this one.
    expect(await store.mintCode(other, "web")).not.toBeNull();
    await store.exchange({
      code: codes[0]!.code,
      label: "x",
      extensionId: RECORDER_EXTENSION_ID,
      installId: "f".repeat(32),
    });
    expect(await store.mintCode(person, "web")).not.toBeNull();
    const later = createRecorderConnectionStore(database, {
      now: () => new Date(Date.now() + 6 * 60_000),
    });
    expect(await later.mintCode(person, "web")).not.toBeNull();
  } finally {
    await database.delete(users).where(eq(users.id, person));
  }
});
