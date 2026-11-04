import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createOrganizationAuth } from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { userRoles, users } from "../src/db/schema";
import {
  purgeConversations,
  seedConversation,
  storedConversation,
} from "./support/conversations";
import { changePreferences, storedPreferences } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestPeople } from "./support/directory";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
// People live in Intelligence's organization directory; these rows are its projection.
const directory = useTestPeople();
afterAll(async () => {
  await database.$client.close();
});

test("verified employee keeps the same-email local account and history identity with the authority's current role", async () => {
  const localId = `local-${randomUUID()}`;
  const authorityId = `authority-${randomUUID()}`;
  const email = `employee-${randomUUID()}@example.test`;
  const channelId = `history-${randomUUID()}`;
  const history = "Existing employee instructions and history owner";
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        user: {
          id: authorityId,
          email,
          name: "Verified Employee",
          role: "user",
        },
      }),
  });
  try {
    await database.insert(users).values({
      id: localId,
      email,
      name: "Existing Employee",
      onboardingStep: 4,
      onboardingCompletedAt: new Date(),
    });
    await setRole(database, localId, "admin");
    await changePreferences(localId, [
      { op: "setInstructions", instructions: history },
    ]);
    // The person's history: a conversation in Intelligence, held under their local id.
    await seedConversation({
      id: channelId,
      name: "Existing conversation",
      description: "Preserved",
      lastMessage: "Existing graphical Bot result",
      members: [{ userId: localId, threadId: null }],
    });
    const auth = createOrganizationAuth({
      authorityUrl: authority.url.origin,
      materializeUser: organizationUserStore(database),
    });
    const cookie =
      "openbot.organization-session=" +
      Buffer.from(
        JSON.stringify({
          authority: authority.url.origin,
          cookie: "better-auth.session_token=fixture",
        }),
      ).toString("base64url");
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user).toMatchObject({ id: localId, email, role: "user" });
    expect(
      await database.select().from(users).where(eq(users.email, email)),
    ).toHaveLength(1);
    expect(
      await database.select().from(users).where(eq(users.id, authorityId)),
    ).toHaveLength(0);
    expect((await storedPreferences(localId)).instructions).toBe(history);
    const [saved] = await database
      .select()
      .from(users)
      .where(eq(users.id, localId));
    const conversation = await storedConversation(channelId);
    expect(conversation.members[0]?.userId).toBe(localId);
    expect(conversation.lastMessage).toBe("Existing graphical Bot result");
    expect(saved?.onboardingStep).toBe(4);
    expect(saved?.onboardingCompletedAt).not.toBeNull();
    // The authority's current role, held by Intelligence's directory and on the row the guard reads;
    // nothing in the old role set.
    expect(saved?.role).toBe("user");
    expect((await directory.client.getPerson(localId))?.role).toBe("user");
    expect(
      await database
        .select()
        .from(userRoles)
        .where(eq(userRoles.userId, localId)),
    ).toEqual([]);
    expect(
      (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
        .id,
    ).toBe(localId);
  } finally {
    authority.stop(true);
    await purgeConversations([channelId]);
    await database.delete(users).where(eq(users.id, localId));
    await database.delete(users).where(eq(users.id, authorityId));
  }
});
