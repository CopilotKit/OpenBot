import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import { channelMemberships, channels, users } from "../src/db/schema";
import { createUserPreferencesStore } from "../src/user-preferences";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createUserPreferencesStore(database);
const channelStore = createChannelStore(
  database,
  createAgentProfileStore(database, undefined),
  createThreadIdentity("tour-test"),
);
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
    proactive: "on",
  });
  expect(await store.patch(alice, { messageListEmphasis: "agent" })).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  expect(await createUserPreferencesStore(database).read(alice)).toEqual({
    messageListEmphasis: "agent",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
    proactive: "on",
  });
  expect(await store.read(bob)).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openbot",
    proactive: "on",
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
    proactive: "on",
  });
});

test("the skin is saved on the account and survives a new store", async () => {
  const id = await person();
  expect(await store.patch(id, { skin: "openmuse" })).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openmuse",
    proactive: "on",
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

test("check-ins are on for a person who never chose, and their off is kept in the database", async () => {
  // Stored preferences written before the switch existed have no key for it, and read as on.
  const id = await person();
  await database
    .update(users)
    .set({ preferences: sql`'{"skin":"openduet"}'::jsonb` })
    .where(eq(users.id, id));
  expect((await store.read(id)).proactive).toBe("on");
  await store.patch(id, { proactive: "off" });
  expect(await createUserPreferencesStore(database).read(id)).toEqual({
    messageListEmphasis: "thread",
    selfHostBannerDismissed: false,
    narration: null,
    skin: "openduet",
    proactive: "off",
  });
  // The jsonb key the check-in claim filters on, as Postgres holds it.
  const [row] = await database
    .select({ proactive: sql<string>`${users.preferences}->>'proactive'` })
    .from(users)
    .where(eq(users.id, id));
  expect(row?.proactive).toBe("off");
});

test("concurrent starter claims across pools keep one winner and unrelated preferences", async () => {
  const id = await person();
  const other = await person();
  await database
    .update(users)
    .set({
      preferences: sql`'{"futurePreference":true,"skin":"openduet"}'::jsonb`,
    })
    .where(eq(users.id, id));
  const secondDatabase = createDatabase(testDatabaseUrl(), TEST_POOL);
  try {
    const secondStore = createUserPreferencesStore(secondDatabase);
    await Promise.all([
      store.claimStarterTour(id, "first"),
      secondStore.claimStarterTour(id, "second"),
      store.patch(id, { narration: "on" }),
    ]);
    const saved = await secondStore.read(id);
    expect(["first", "second"]).toContain(saved.starterTourChannelId ?? "");
    expect(saved).toMatchObject({
      skin: "openduet",
      narration: "on",
    });
    expect(saved).toHaveProperty("futurePreference", true);
    await secondStore.claimStarterTour(id, "later");
    expect((await store.read(id)).starterTourChannelId).toBe(
      saved.starterTourChannelId,
    );
    expect((await store.read(other)).starterTourChannelId).toBeUndefined();
  } finally {
    await secondDatabase.$client.close();
  }
});

test.each([
  { used: false, discard: true, matching: true, released: true },
  { used: true, discard: true, matching: true, released: false },
  { used: false, discard: false, matching: true, released: false },
  { used: false, discard: true, matching: false, released: false },
])(
  "only explicit failed-start deletion releases a matching empty tour: %j",
  async ({ used, discard, matching, released }) => {
    const id = await person();
    const other = await person();
    const channelId = `tour-${randomUUID()}`;
    await database.insert(channels).values({
      id: channelId,
      name: "Starter",
      description: "",
      lastMessageAt: used ? new Date() : null,
    });
    try {
      await database
        .insert(channelMemberships)
        .values({ channelId, userId: id });
      await store.claimStarterTour(id, matching ? channelId : "different");
      await store.claimStarterTour(other, channelId);
      await store.patch(id, {
        skin: "openduet",
      });
      await channelStore.softDelete({ id, role: "user" }, channelId, discard);
      const saved = await store.read(id);
      expect(saved.starterTourChannelId).toBe(
        released ? undefined : matching ? channelId : "different",
      );
      expect(saved.skin).toBe("openduet");
      expect((await store.read(other)).starterTourChannelId).toBe(channelId);
      await store.claimStarterTour(id, "retry");
      expect((await store.read(id)).starterTourChannelId).toBe(
        released ? "retry" : saved.starterTourChannelId,
      );
      // A duplicate delete must never release a subsequent claim.
      await channelStore.softDelete({ id, role: "user" }, channelId, discard);
      expect((await store.read(id)).starterTourChannelId).toBe(
        released ? "retry" : saved.starterTourChannelId,
      );
    } finally {
      await database.delete(channels).where(eq(channels.id, channelId));
    }
  },
);
