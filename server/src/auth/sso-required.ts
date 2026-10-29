import { and, type Column, eq, inArray, notInArray, sql } from "drizzle-orm";
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
  const ended = await database
    .delete(sessions)
    .where(
      withoutSso(database, initialAdminEmails, sessions.userId, keepUserId),
    )
    .returning({ id: sessions.id });
  return ended.length;
}

/**
 * Which of these people SSO-required signs out: the same people {@link revokeSessionsWithoutSso} ends the sessions of,
 * asked of a list rather than of the sessions table, so what else they are signed in with (their Recorders) can be
 * ended first, and again on a retry once their sessions are already gone.
 */
export async function peopleWithoutSso(
  database: Database,
  initialAdminEmails: readonly string[],
  among: readonly string[],
  keepUserId?: string,
): Promise<string[]> {
  if (among.length === 0) return [];
  const rows = await database
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, [...among]),
        withoutSso(database, initialAdminEmails, users.id, keepUserId),
      ),
    );
  return rows.map((row) => row.id);
}

/** A person (`userId`, a column holding one) with no account at a registered identity provider, who is neither a
 * break-glass address nor `keepUserId`. */
function withoutSso(
  database: Database,
  initialAdminEmails: readonly string[],
  userId: Column,
  keepUserId?: string,
) {
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
  return and(
    notInArray(userId, breakGlass),
    notInArray(userId, signedInWithSso),
    ...(keepUserId ? [sql`${userId} <> ${keepUserId}`] : []),
  );
}

/** Whether any enterprise identity provider is registered, which SSO-required depends on. */
export async function hasIdentityProvider(database: Database) {
  const [row] = await database
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .limit(1);
  return Boolean(row);
}
