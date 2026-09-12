import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { stampSignIn } from "../src/auth";
import { createDatabase } from "../src/db/client";
import { revokedAccess, sessions, users } from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const store = createPeopleStore(database, []);
const PREFIX = "last-sign-in-test-";
const ids: string[] = [];

const SIGNED_IN_AT = new Date("2026-09-05T09:00:00.000Z");

async function person(
  suffix: string,
  signedInAt: Date | null,
): Promise<string> {
  const id = `${PREFIX}${suffix}`;
  ids.push(id);
  await database.insert(users).values({
    id,
    email: `${id}@openbot.test`,
    name: id,
    emailVerified: true,
    lastSignedInAt: signedInAt,
  });
  if (signedInAt) {
    await database.insert(sessions).values({
      id: `${id}-session`,
      userId: id,
      token: `${id}-token`,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: signedInAt,
    });
  }
  return id;
}

afterEach(async () => {
  if (ids.length === 0) return;
  await database.delete(sessions).where(inArray(sessions.userId, ids));
  await database.delete(users).where(inArray(users.id, ids));
  await database.delete(revokedAccess).where(
    inArray(
      revokedAccess.email,
      ids.map((id) => `${id}@openbot.test`),
    ),
  );
  ids.length = 0;
});

describe("when somebody was last here", () => {
  test("survives an administrator removing them, and coming back", async () => {
    const dana = await person("dana", SIGNED_IN_AT);

    await store.revoke(dana, "an-admin");
    const removed = await store.find(dana);
    expect(removed?.revoked).toBe(true);
    expect(removed?.lastSignedInAt).toBe(SIGNED_IN_AT.toISOString());

    await store.restore(dana);
    const back = await store.find(dana);
    expect(back?.revoked).toBe(false);
    expect(back?.lastSignedInAt).toBe(SIGNED_IN_AT.toISOString());
  });

  test("survives the session row going away, which is what signing out does", async () => {
    const dana = await person("dana", SIGNED_IN_AT);

    await database.delete(sessions).where(eq(sessions.userId, dana));

    expect((await store.find(dana))?.lastSignedInAt).toBe(
      SIGNED_IN_AT.toISOString(),
    );
  });

  test("keeps their place in the list across a removal and a restore", async () => {
    const zoe = await person("zoe", SIGNED_IN_AT);
    await person("mia", new Date("2026-09-04T09:00:00.000Z"));
    await person("abe", null);

    await store.revoke(zoe, "an-admin");
    await store.restore(zoe);

    const { people } = await store.list({ search: PREFIX });
    expect(people.map((one) => one.id.replace(PREFIX, ""))).toEqual([
      "zoe",
      "mia",
      "abe",
    ]);
  });

  test("a sign-in stamps the person it belongs to and nobody else", async () => {
    const dana = await person("dana", null);
    const other = await person("other", null);

    await stampSignIn(database, dana, SIGNED_IN_AT);

    expect((await store.find(dana))?.lastSignedInAt).toBe(
      SIGNED_IN_AT.toISOString(),
    );
    expect((await store.find(other))?.lastSignedInAt).toBeNull();
  });

  test("an out-of-order stamp does not move the answer backwards", async () => {
    const dana = await person("dana", null);
    const earlier = new Date("2026-09-01T09:00:00.000Z");

    await stampSignIn(database, dana, SIGNED_IN_AT);
    await stampSignIn(database, dana, earlier);

    expect((await store.find(dana))?.lastSignedInAt).toBe(
      SIGNED_IN_AT.toISOString(),
    );
  });

  test("a stamp that cannot be written does not refuse the sign-in", async () => {
    const broken = {
      update: () => {
        throw new Error("the database is unavailable");
      },
    } as unknown as Parameters<typeof stampSignIn>[0];

    expect(
      stampSignIn(broken, "anybody", SIGNED_IN_AT),
    ).resolves.toBeUndefined();
  });
});
