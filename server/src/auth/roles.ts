import { and, eq, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import { userRoles, users } from "../db/schema";

export type OpenBotRole = "admin" | "user";

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): OpenBotRole {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  )
    ? "admin"
    : "user";
}

/**
 * Bring somebody's role in line with the deployment's administrator list.
 *
 * Applied on every sign-in, not only when the account is first created. Writing it once at creation
 * was a trap with no way out: adding yourself to `INITIAL_ADMIN_EMAILS` after you had already signed
 * in did nothing, the row said `user` for ever, and no route anywhere changes a role. Somebody who
 * signed in before editing their `.env` had an adminless deployment and no way to fix it short of
 * editing the database by hand.
 *
 * It demotes as well as promotes, because `user_roles` is a set and the guard takes `admin` if any
 * row says so. An address removed from the list therefore has to lose its `admin` row, or a former
 * administrator is one nobody can remove.
 *
 * Delete-then-insert inside one transaction, because between the two a request arriving on another
 * process would find no row at all and be refused with a 403 that looks like a permissions bug.
 */
export async function reconcileRole(
  database: Database,
  userId: string,
  email: string,
  initialAdminEmails: readonly string[],
): Promise<OpenBotRole> {
  const role = roleForEmail(email, initialAdminEmails);

  await database.transaction(async (tx) => {
    await tx
      .delete(userRoles)
      .where(and(eq(userRoles.userId, userId), ne(userRoles.role, role)));
    await tx.insert(userRoles).values({ userId, role }).onConflictDoNothing();
  });

  return role;
}

/**
 * The same, for somebody identified only by the session being created.
 *
 * A session hook is handed a user id and no email, and the list is written in email addresses, so
 * the address has to be read back before the two can be compared.
 */
export async function reconcileRoleForUserId(
  database: Database,
  userId: string,
  initialAdminEmails: readonly string[],
): Promise<void> {
  const [user] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // No user means a session is being made for somebody who is not there, which is not this module's
  // to report: Better Auth is about to fail on its own and would only be given a worse message here.
  if (!user) return;

  await reconcileRole(database, userId, user.email, initialAdminEmails);
}
