import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createUserPreferencesStore } from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createUserPreferencesStore(database);
const ids: string[] = [];
async function person() {
  const id = `preferences-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  ids.push(id);
  return id;
}
afterEach(async () => {
  for (const id of ids.splice(0))
    await database.delete(users).where(eq(users.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

test("database defaults and writes survive a new store and remain scoped to the user", async () => {
  const alice = await person();
  const bob = await person();
  expect(await store.read(alice)).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
  });
  expect(await store.patch(alice, { messageListEmphasis: "agent" })).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
  });
  expect(await createUserPreferencesStore(database).read(alice)).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
  });
  expect(await store.read(bob)).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
  });
});

test("patching one preference preserves other JSON fields", async () => {
  const id = await person();
  await database
    .update(users)
    .set({ preferences: sql`'{"futurePreference":true}'::jsonb` })
    .where(eq(users.id, id));
  await store.patch(id, { messageListEmphasis: "agent" });
  const [user] = await database
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, id));
  expect(user?.preferences).toEqual({
    messageListEmphasis: "agent",
    futurePreference: true,
  });
});

test("missing users do not appear successfully saved", async () => {
  const id = `missing-${randomUUID()}`;
  await expect(store.read(id)).rejects.toThrow("could not be found");
  await expect(
    store.patch(id, { messageListEmphasis: "agent" }),
  ).rejects.toThrow("could not be saved");
});

test("the narration choice is kept in the database beside the others", async () => {
  const id = await person();
  expect((await store.read(id)).narration).toBe(null);
  await store.patch(id, { narration: "on" });
  expect(await createUserPreferencesStore(database).read(id)).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: "on",
    skin: "openbot",
  });
});

test("the skin is saved on the account and survives a new store", async () => {
  const id = await person();
  expect(await store.patch(id, { skin: "openmuse" })).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openmuse",
  });
  expect((await createUserPreferencesStore(database).read(id)).skin).toBe(
    "openmuse",
  );
});

test("a stored skin this build does not ship reads as the default", async () => {
  const id = await person();
  await database
    .update(users)
    .set({ preferences: sql`'{"skin":"retired-skin"}'::jsonb` })
    .where(eq(users.id, id));
  expect((await store.read(id)).skin).toBe("openbot");
});
