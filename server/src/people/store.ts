import { eq, inArray, sql } from "drizzle-orm";
import { isConfiguredAdmin, type OpenBotRole, setRole } from "../auth/roles";
import type { Database } from "../db/client";
import {
  accounts,
  revokedAccess,
  sessions,
  userRoles,
  users,
} from "../db/schema";

/**
 * Everybody who has signed in, and what an administrator may do about them.
 *
 * People appear here by having signed in, not by being invited: a deployment's identity provider
 * decides who exists, and this decides what they may do once they are here.
 */
export type Person = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: OpenBotRole;
  /**
   * Which identity providers this person has arrived through. More than one is normal for a company
   * mid-migration, where the same address exists in both Entra and Okta.
   */
  providers: string[];
  lastSignedInAt: string | null;
  /** Whether an administrator has removed them. A revoked person keeps their row and their history. */
  revoked: boolean;
  /**
   * Whether this person's role is fixed by `INITIAL_ADMIN_EMAILS`.
   *
   * The screen renders this rather than recomputing it: the deployment's configuration is the floor
   * that guarantees a way back in, so somebody it names cannot be demoted or removed here.
   */
  configuredAdmin: boolean;
};

export type PeopleStore = {
  list: () => Promise<Person[]>;
  setRole: (userId: string, role: OpenBotRole) => Promise<void>;
  revoke: (userId: string, revokedBy: string) => Promise<void>;
  restore: (userId: string) => Promise<void>;
  find: (userId: string) => Promise<Person | undefined>;
  isRevoked: (email: string) => Promise<boolean>;
};

/** One spelling of an address, so a provider's choice of case cannot create a second person. */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export function createPeopleStore(
  database: Database,
  initialAdminEmails: readonly string[],
): PeopleStore {
  async function list(): Promise<Person[]> {
    const rows = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        /*
         * Aggregated rather than joined into duplicate rows. `user_roles` is a set and `accounts`
         * has one row per provider, so a plain join would return the same person once per
         * combination and the screen would list them several times.
         */
        roles: sql<
          string[]
        >`coalesce(array_agg(distinct ${userRoles.role}) filter (where ${userRoles.role} is not null), '{}')`,
        providers: sql<
          string[]
        >`coalesce(array_agg(distinct ${accounts.providerId}) filter (where ${accounts.providerId} is not null), '{}')`,
        lastSignedInAt: sql<Date | null>`max(${sessions.createdAt})`,
        revoked: sql<boolean>`bool_or(${revokedAccess.email} is not null)`,
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(accounts, eq(accounts.userId, users.id))
      .leftJoin(sessions, eq(sessions.userId, users.id))
      .leftJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(${users.email})`),
      )
      .groupBy(users.id)
      /*
       * Most recently here first, and `NULLS LAST` on purpose.
       *
       * Postgres sorts nulls first on a descending order, so without it everybody who has never
       * signed in floats above everybody who just did. On a deployment of any size that is the
       * whole first screen given to people who have never used it.
       */
      .orderBy(sql`max(${sessions.createdAt}) desc nulls last`, users.email);

    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      image: row.image,
      // `admin` wins, the same way the request guard reads it. Anything else is a plain user.
      role: row.roles.includes("admin") ? "admin" : "user",
      providers: row.providers,
      lastSignedInAt: row.lastSignedInAt
        ? new Date(row.lastSignedInAt).toISOString()
        : null,
      revoked: row.revoked === true,
      configuredAdmin: isConfiguredAdmin(row.email, initialAdminEmails),
    }));
  }

  async function find(userId: string): Promise<Person | undefined> {
    return (await list()).find((person) => person.id === userId);
  }

  return {
    list,
    find,

    async setRole(userId, role) {
      await setRole(database, userId, role);
    },

    /**
     * Remove somebody, and end the session they are using.
     *
     * Both halves matter. The deny list stops the next sign-in, and deleting the sessions stops the
     * current one: without that, somebody removed keeps working until their cookie happens to
     * expire, which can be days.
     */
    async revoke(userId, revokedBy) {
      const [user] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return;

      await database.transaction(async (tx) => {
        await tx
          .insert(revokedAccess)
          .values({ email: normalize(user.email), revokedBy })
          .onConflictDoNothing();
        await tx.delete(sessions).where(eq(sessions.userId, userId));
      });
    },

    async restore(userId) {
      const [user] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) return;

      await database
        .delete(revokedAccess)
        .where(eq(revokedAccess.email, normalize(user.email)));
    },

    async isRevoked(email) {
      const rows = await database
        .select({ email: revokedAccess.email })
        .from(revokedAccess)
        .where(inArray(revokedAccess.email, [normalize(email)]))
        .limit(1);
      return rows.length > 0;
    },
  };
}
