import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createOrganizationAuth } from "../src/auth/organization";
import { organizationUserStore } from "../src/auth/organization-store";
import { setRole } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import {
  channelMemberships,
  channels,
  userInstructions,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
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
    await database
      .insert(userInstructions)
      .values({ userId: localId, instructions: history });
    await database.insert(channels).values({
      id: channelId,
      name: "Existing conversation",
      description: "Preserved",
      lastMessage: "Existing graphical Bot result",
    });
    await database
      .insert(channelMemberships)
      .values({ channelId, userId: localId });
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
    const [instructions] = await database
      .select()
      .from(userInstructions)
      .where(eq(userInstructions.userId, localId));
    expect(instructions?.instructions).toBe(history);
    const [saved] = await database
      .select()
      .from(users)
      .where(eq(users.id, localId));
    expect(
      (
        await database
          .select()
          .from(channelMemberships)
          .where(eq(channelMemberships.channelId, channelId))
      )[0]?.userId,
    ).toBe(localId);
    expect(
      (
        await database.select().from(channels).where(eq(channels.id, channelId))
      )[0]?.lastMessage,
    ).toBe("Existing graphical Bot result");
    expect(saved?.onboardingStep).toBe(4);
    expect(saved?.onboardingCompletedAt).not.toBeNull();
    expect(
      (
        await database
          .select()
          .from(userRoles)
          .where(eq(userRoles.userId, localId))
      ).map((row) => row.role),
    ).toEqual(["user"]);
    expect(
      (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
        .id,
    ).toBe(localId);
  } finally {
    authority.stop(true);
    await database.delete(channels).where(eq(channels.id, channelId));
    await database.delete(users).where(eq(users.id, localId));
    await database.delete(users).where(eq(users.id, authorityId));
  }
});
