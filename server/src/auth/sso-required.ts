import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, sessions, ssoProviders, users } from "../db/schema/core";

/**
 * Called whenever SSO-required is saved on. Sign-in is checked only when a session is made, and a
 * session renews while it is used, so without this everybody already signed in with Google or a
 * password stays in indefinitely.
 *
 * Ends the sessions of people with no account at a registered identity provider. Kept: people who
 * have signed in through one (they would sign straight back in), the break-glass addresses in
 * INITIAL_ADMIN_EMAILS (who may still sign in another way), and the administrator saving the setting,
 * so the click does not sign them out mid-change. Safe to run again, which is how a failed attempt is
 * retried. Returns how many sessions ended.
 */
export async function revokeSessionsWithoutSso(
  database: Database,
  initialAdminEmails: readonly string[],
  keepUserId?: string,
): Promise<number> {
  const admins = initialAdminEmails
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const breakGlass = database
    .select({ id: users.id })
    .from(users)
    .where(
      admins.length ? inArray(sql`lower(${users.email})`, admins) : sql`false`,
    );
  const signedInWithSso = database
    .select({ id: accounts.userId })
    .from(accounts)
    .innerJoin(ssoProviders, eq(ssoProviders.providerId, accounts.providerId));
  const ended = await database
    .delete(sessions)
    .where(
      and(
        notInArray(sessions.userId, breakGlass),
        notInArray(sessions.userId, signedInWithSso),
        ...(keepUserId ? [sql`${sessions.userId} <> ${keepUserId}`] : []),
      ),
    )
    .returning({ id: sessions.id });
  return ended.length;
}

/** Whether any enterprise identity provider is registered, which SSO-required depends on. */
export async function hasIdentityProvider(database: Database) {
  const [row] = await database
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .limit(1);
  return Boolean(row);
}
