import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { revokedAccess, sessions, users } from "../src/db/schema";
import { createPeopleStore } from "../src/people/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const adminId = `offboarding-admin-${suite}`;
const memberId = `offboarding-member-${suite}`;
const memberEmail = `${memberId}@openbot.test`;

const ADMIN = {
  id: adminId,
  email: `${adminId}@openbot.test`,
  name: "An Administrator",
  image: null,
};

afterAll(async () => {
  await database
    .delete(revokedAccess)
    .where(eq(revokedAccess.email, memberEmail));
  await database.delete(sessions).where(eq(sessions.userId, memberId));
  await database.delete(users).where(inArray(users.id, [adminId, memberId]));
});

function appFor(retire: () => Promise<{ retired: number }>) {
  const events: string[] = [];
  const store = createPeopleStore(database, [], retire);
  const auditStore = {
    insert: async (event: { eventType: string }) => {
      events.push(event.eventType);
    },
  };

  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => ["admin"] },
    ...(Array.from({ length: 9 }) as never[]),
    auditStore as never,
    ...(Array.from({ length: 4 }) as never[]),
    store as never,
  );

  return {
    events,
    remove: () =>
      app.request(`http://openbot.test/api/admin/people/${memberId}/access`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revoked: true }),
      }),
  };
}

test("a broker that will not answer still leaves the removal on the trail, and asking again finishes it", async () => {
  await database
    .insert(users)
    .values([
      {
        id: adminId,
        email: ADMIN.email,
        name: "An Administrator",
        emailVerified: true,
      },
      {
        id: memberId,
        email: memberEmail,
        name: "A Member",
        emailVerified: true,
      },
    ])
    .onConflictDoNothing();
  await database.insert(sessions).values({
    id: `${memberId}-session`,
    userId: memberId,
    token: `${memberId}-token`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  let attempts = 0;
  const { events, remove } = appFor(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("composio: 503 Service Unavailable");
    }
    return { retired: 0 };
  });

  expect((await remove()).status).toBe(500);

  const denied = await database
    .select({ email: revokedAccess.email })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, memberEmail));
  expect(denied).toHaveLength(1);
  expect(
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, memberId)),
  ).toEqual([]);
  expect(events).toEqual(["person.access_revoked"]);

  expect((await remove()).status).toBe(200);
  expect(attempts).toBe(2);
  expect(events).toEqual(["person.access_revoked"]);
});
