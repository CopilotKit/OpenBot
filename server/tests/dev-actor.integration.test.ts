import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DEV_ACTOR, initializeDevActorUser } from "../src/auth/dev-actor";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

describe("development actor persistence", () => {
  test("does not access the database when disabled", async () => {
    const inaccessibleDatabase = {
      get insert(): never {
        throw new Error("disabled initialization accessed the database");
      },
    };

    expect(await initializeDevActorUser(inaccessibleDatabase, false)).toBe(
      false,
    );
  });

  test("writes only when enabled and restores the canonical user identity", async () => {
    const rollback = new Error("rollback development actor test");

    await expect(
      database.transaction(async (transaction) => {
        await transaction.delete(users).where(eq(users.id, DEV_ACTOR.id));

        expect(await initializeDevActorUser(transaction, false)).toBe(false);
        expect(
          await transaction
            .select()
            .from(users)
            .where(eq(users.id, DEV_ACTOR.id)),
        ).toEqual([]);

        expect(await initializeDevActorUser(transaction, true)).toBe(true);
        const firstRows = await transaction
          .select()
          .from(users)
          .where(eq(users.id, DEV_ACTOR.id));
        expect(firstRows).toHaveLength(1);
        expect(firstRows[0]).toMatchObject({
          id: DEV_ACTOR.id,
          email: DEV_ACTOR.email,
          name: DEV_ACTOR.name ?? DEV_ACTOR.email,
          emailVerified: false,
          groups: [],
          createdAt: expect.any(Date),
          updatedAt: expect.any(Date),
        });

        await transaction
          .update(users)
          .set({
            email: `changed-${randomUUID()}@example.test`,
            name: "Changed",
          })
          .where(eq(users.id, DEV_ACTOR.id));
        expect(await initializeDevActorUser(transaction, true)).toBe(true);

        const restoredRows = await transaction
          .select()
          .from(users)
          .where(eq(users.id, DEV_ACTOR.id));
        expect(restoredRows).toHaveLength(1);
        expect(restoredRows[0]).toMatchObject({
          id: DEV_ACTOR.id,
          email: DEV_ACTOR.email,
          name: DEV_ACTOR.name ?? DEV_ACTOR.email,
        });

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  test("fails loudly when another user owns the development email", async () => {
    const conflictingUserId = `dev-actor-conflict-${randomUUID()}`;

    await expect(
      database.transaction(async (transaction) => {
        await transaction.delete(users).where(eq(users.id, DEV_ACTOR.id));
        await transaction.insert(users).values({
          id: conflictingUserId,
          email: DEV_ACTOR.email,
          name: "Conflicting User",
        });

        await initializeDevActorUser(transaction, true);
      }),
    ).rejects.toThrow();

    expect(
      await database
        .select()
        .from(users)
        .where(eq(users.id, conflictingUserId)),
    ).toEqual([]);
  });
});
