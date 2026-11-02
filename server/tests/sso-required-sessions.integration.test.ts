import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { revokeSessionsWithoutSso } from "../src/auth/sso-required";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { accounts, sessions, ssoProviders, users } from "../src/db/schema/core";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createEnterpriseStore(db);
const prefix = `sso-${randomUUID()}`;
const member = `${prefix}-member`;
const admin = `${prefix}-admin`;
const adminEmail = `${admin}@example.test`;
const session = (userId: string) => ({
  id: randomUUID(),
  userId,
  token: randomUUID(),
  expiresAt: new Date(Date.now() + 86_400_000),
});
beforeAll(async () => {
  await db.insert(users).values([
    { id: member, email: `${member}@example.test` },
    { id: admin, email: adminEmail },
  ]);
});
afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [member, admin]));
  await db
    .delete(enterpriseSettings)
    .where(eq(enterpriseSettings.key, "sso_required"));
  await db.$client.end({ timeout: 5 });
});

test("turning SSO-required on ends every session but the break-glass administrators'", async () => {
  // Both signed in with Google before the switch.
  const google = session(member);
  const breakGlass = session(admin);
  await db.insert(sessions).values([google, breakGlass]);

  // Saving the setting alone leaves the Google session working.
  await store.setSetting("ssoRequired", true, adminEmail);
  const survived = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, google.id));
  expect(survived).toHaveLength(1);

  // What the save must also do: only a new sign-in, which now has to be SSO, gets back in.
  expect(
    await revokeSessionsWithoutSso(db, [adminEmail]),
  ).toBeGreaterThanOrEqual(1);
  const left = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(inArray(sessions.id, [google.id, breakGlass.id]));
  expect(left.map((row) => row.id)).toEqual([breakGlass.id]);
});

test("SSO-required keeps the people already signed in through SSO, and the administrator saving it", async () => {
  const providerId = `${prefix}-okta`;
  const ssoUser = `${prefix}-sso`;
  const acting = `${prefix}-acting`;
  const googleUser = `${prefix}-google`;
  await db.insert(users).values([
    { id: ssoUser, email: `${ssoUser}@example.test` },
    { id: acting, email: `${acting}@example.test` },
    { id: googleUser, email: `${googleUser}@example.test` },
  ]);
  await db.insert(ssoProviders).values({
    id: providerId,
    issuer: "https://idp.example.test",
    providerId,
    domain: "example.test",
  });
  await db.insert(accounts).values({
    id: randomUUID(),
    accountId: "idp-subject",
    providerId,
    userId: ssoUser,
  });
  const viaSso = session(ssoUser);
  const viaGoogle = session(googleUser);
  const saving = session(acting);
  await db.insert(sessions).values([viaSso, viaGoogle, saving]);
  try {
    await revokeSessionsWithoutSso(db, [adminEmail], acting);
    const left = (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.id, [viaSso.id, viaGoogle.id, saving.id]))
    ).map((row) => row.id);
    expect(left.sort()).toEqual([viaSso.id, saving.id].sort());
    // Saving it again is safe: nothing more ends.
    await revokeSessionsWithoutSso(db, [adminEmail], acting);
    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(inArray(sessions.id, [viaSso.id, saving.id])),
    ).toHaveLength(2);
  } finally {
    await db.delete(ssoProviders).where(eq(ssoProviders.id, providerId));
    await db
      .delete(users)
      .where(inArray(users.id, [ssoUser, acting, googleUser]));
  }
});
