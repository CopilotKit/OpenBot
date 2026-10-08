import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { identityLinks } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const realm = `test-${randomUUID()}`;

afterAll(async () => {
  await database.delete(identityLinks).where(eq(identityLinks.realm, realm));
  await database.$client.close();
});

const row = (subject: string, userId: string) => ({
  id: randomUUID(),
  provider: "slack",
  realm,
  subject,
  userId,
  verifiedBy: "challenge" as const,
});

test("an outside account links to one user", async () => {
  await database.insert(identityLinks).values(row("U1", "user-a"));
  await expect(
    database.insert(identityLinks).values(row("U1", "user-b")).execute(),
  ).rejects.toThrow();
});

test("a user has one account per provider and realm", async () => {
  await database.insert(identityLinks).values(row("U2", "user-c"));
  await expect(
    database.insert(identityLinks).values(row("U3", "user-c")).execute(),
  ).rejects.toThrow();
});

test("verified_by and status are constrained", async () => {
  await expect(
    database
      .insert(identityLinks)
      .values({ ...row("U4", "user-d"), verifiedBy: "guess" as never })
      .execute(),
  ).rejects.toThrow();
  await expect(
    database
      .insert(identityLinks)
      .values({ ...row("U5", "user-e"), status: "gone" as never })
      .execute(),
  ).rejects.toThrow();
});
