import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { people } from "../people/directory/directory";

export type OpenBotRole = "admin" | "user";

/**
 * Whether this address is an administrator by configuration.
 *
 * A floor, not the whole answer. Somebody named here is always an administrator and cannot be
 * demoted from the admin screen, which is what makes it the way back in when the last administrator
 * demotes themselves by accident. Everybody else's role is whatever an administrator has set.
 */
export function isConfiguredAdmin(
  email: string,
  initialAdminEmails: readonly string[],
): boolean {
  const normalizedEmail = email.trim().toLowerCase();

  return initialAdminEmails.some(
    (adminEmail) => adminEmail.trim().toLowerCase() === normalizedEmail,
  );
}

export function roleForEmail(
  email: string,
  initialAdminEmails: readonly string[],
): OpenBotRole {
  return isConfiguredAdmin(email, initialAdminEmails) ? "admin" : "user";
}

/**
 * Give somebody exactly one role.
 *
 * The role is the person's in Intelligence's directory (people/directory), written there first; their
 * row here is then updated from the directory's answer, which is what the request guard reads. One
 * field rather than the old `user_roles` set, so there is never a moment with no role at all.
 */
export async function setRole(
  _database: Database,
  userId: string,
  role: OpenBotRole,
): Promise<OpenBotRole> {
  await people().update(userId, (current) =>
    current.role === role ? null : { role },
  );
  return role;
}

/**
 * The role a brand-new account starts with.
 *
 * The only moment configuration decides somebody who is not on the list: from here on that person's
 * role belongs to whoever administers the deployment.
 */
export async function seedRole(
  database: Database,
  userId: string,
  email: string,
  initialAdminEmails: readonly string[],
): Promise<OpenBotRole> {
  return setRole(database, userId, roleForEmail(email, initialAdminEmails));
}

/**
 * Re-apply the configured floor, on every sign-in.
 *
 * Only ever promotes, and only for an address the deployment names. Somebody added to the list
 * after they first signed in becomes an administrator at their next sign-in, which is the trap this
 * exists to close: the role used to be written once at account creation, so editing the list did
 * nothing at all and no screen could fix it.
 *
 * Everybody else is left exactly as they are, because their role is the admin screen's to decide and
 * a sign-in that overwrote it would make that screen lie the moment they came back.
 *
 * Answers whether this call is what granted the role, so the caller can put that on the audit trail.
 * Anybody who can edit the configuration can make themselves an administrator, and until this
 * returned something there was no row anywhere saying it had happened.
 */
export async function applyConfiguredAdmin(
  database: Database,
  userId: string,
  initialAdminEmails: readonly string[],
): Promise<boolean> {
  // Nothing configured cannot promote anybody, so there is no reason to read the user back.
  if (initialAdminEmails.length === 0) return false;

  const [user] = await database
    .select({ email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // No user means a session is being made for somebody who is not there, which is not this module's
  // to report: Better Auth is about to fail on its own and would only be given a worse message here.
  if (!user) return false;

  if (!isConfiguredAdmin(user.email, initialAdminEmails)) return false;

  // Already an administrator: nothing to grant, and nothing to ask Intelligence.
  if (user.role === "admin") return false;

  await setRole(database, userId, "admin");

  // Whether this sign-in is what granted it. The caller writes an audit row when it did, and a
  // returning administrator must not produce one on every sign-in.
  return true;
}
