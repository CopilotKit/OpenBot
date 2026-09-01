import { and, eq, inArray, sql } from "drizzle-orm";
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

/** One page of people, and whether there is another. */
export type PeoplePage = {
  people: Person[];
  /**
   * The cursor for the next page, or null at the end.
   *
   * Keyset rather than an offset. An offset re-reads and discards everything before it, so page 50
   * is fifty times the work of page 1, and a person who signs in while somebody is paging shifts
   * every later row by one and hides another person entirely.
   */
  nextCursor: string | null;
};

/** What a page request may ask for. */
export type PeopleQuery = {
  /** Substring of the address or the name, case-insensitively. */
  search?: string;
  /** From a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
  /** One person, by id. Used by `find`, which needs the same aggregate for one row. */
  id?: string;
};

export type PeopleStore = {
  /**
   * One page of people, newest sign-in first.
   *
   * Bounded because this grows with the company. It used to take no arguments and return everybody,
   * joined to their roles, accounts and sessions, on every render of the admin screen.
   */
  list: (query?: PeopleQuery) => Promise<PeoplePage>;
  setRole: (userId: string, role: OpenBotRole) => Promise<void>;
  revoke: (userId: string, revokedBy: string) => Promise<void>;
  restore: (userId: string) => Promise<void>;
  find: (userId: string) => Promise<Person | undefined>;
  isRevoked: (email: string) => Promise<boolean>;
  /** The OpenBot-owned override, separate from the identity provider's image. */
  avatar: (userId: string) => Promise<string | null>;
  setAvatar: (userId: string, image: string | null) => Promise<void>;
};

/** How many people a page holds when the caller does not say. */
const DEFAULT_PAGE = 50;

/**
 * The most a caller may ask for in one page.
 *
 * A ceiling rather than a suggestion, because the limit arrives over HTTP and the whole point of
 * paging is that no single request can be made to read the entire deployment.
 */
const MAX_PAGE = 200;

/** Where a page stopped. Both halves of the sort, because either alone is ambiguous. */
type Cursor = { lastSignedInAt: string | null; email: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Read a cursor a client sent back.
 *
 * A malformed one is treated as no cursor rather than as an error: it means the first page, which is
 * a sensible answer to a stale or hand-edited link, and there is nothing here worth refusing over.
 */
function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (typeof parsed?.email !== "string") return undefined;
    return {
      email: parsed.email,
      lastSignedInAt:
        typeof parsed.lastSignedInAt === "string"
          ? parsed.lastSignedInAt
          : null,
    };
  } catch {
    return undefined;
  }
}

/** So a search for `100%` finds that and not everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** One spelling of an address, so a provider's choice of case cannot create a second person. */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * What else has to be retired when somebody is removed.
 *
 * A seam rather than an import, because this module has no business knowing what a connector is —
 * and because the list of things a person owns will grow. It exists at all because removing somebody
 * used to end their sessions and leave every credential they had granted this deployment sitting in
 * the vault, usable: true of their access, false of the secret, and only the first of those is what
 * an administrator was told they did.
 *
 * Optional, so a deployment without connectors is unchanged and a test can leave it out. Absent
 * means nothing extra is retired, which is the behaviour this replaced rather than a new risk.
 */
export type OwnedCredentialRetirer = (
  userId: string,
  by: string,
) => Promise<{ retired: number }>;

export function createPeopleStore(
  database: Database,
  initialAdminEmails: readonly string[],
  retireOwnedCredentials?: OwnedCredentialRetirer,
): PeopleStore {
  async function list(query: PeopleQuery = {}): Promise<PeoplePage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const cursor = decodeCursor(query.cursor);
    const search = query.search?.trim();

    const filters = [];
    if (query.id) filters.push(eq(users.id, query.id));
    if (search) {
      // Both fields, because an administrator looking for somebody has one or the other in mind and
      // should not have to know which the deployment stored.
      const pattern = `%${escapeLike(search)}%`;
      filters.push(
        sql`(${users.email} ilike ${pattern} escape '\\' or coalesce(${users.name}, '') ilike ${pattern} escape '\\')`,
      );
    }

    const rows = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        // Provider image only. The OpenBot-owned avatar has its own authenticated endpoint; putting
        // its data URL in this page would copy up to 2 MB into every administrator list row.
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
      .where(filters.length > 0 ? and(...filters) : undefined)
      .groupBy(users.id)
      /*
       * Most recently here first, and `NULLS LAST` on purpose.
       *
       * Postgres sorts nulls first on a descending order, so without it everybody who has never
       * signed in floats above everybody who just did. On a deployment of any size that is the
       * whole first screen given to people who have never used it.
       */
      /*
       * The keyset, applied after grouping because it is about the aggregate.
       *
       * The sort is (last sign-in desc nulls last, email asc), so the cursor has to compare on both
       * or two people who signed in within the same millisecond would hide each other. `nulls last`
       * is why this is written out rather than a plain tuple comparison: a null on the descending
       * side sorts after every value, which is the opposite of what `<` says about it.
       */
      .having(
        cursor
          ? sql`(
              (max(${sessions.createdAt}) is null and (${cursor.lastSignedInAt}::timestamptz is not null or ${users.email} > ${cursor.email}))
              or (max(${sessions.createdAt}) is not null and ${cursor.lastSignedInAt}::timestamptz is not null and (
                max(${sessions.createdAt}) < ${cursor.lastSignedInAt}::timestamptz
                or (max(${sessions.createdAt}) = ${cursor.lastSignedInAt}::timestamptz and ${users.email} > ${cursor.email})
              ))
            )`
          : undefined,
      )
      .orderBy(sql`max(${sessions.createdAt}) desc nulls last`, users.email)
      // One more than asked for, so "is there another page" is answered without a second count
      // query over the same aggregate.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      people: page.map((row) => ({
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
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({
              lastSignedInAt: last.lastSignedInAt
                ? new Date(last.lastSignedInAt).toISOString()
                : null,
              email: last.email,
            })
          : null,
    };
  }

  /**
   * One person, by id.
   *
   * Its own query. This used to be `(await list()).find(...)`, which ran the whole aggregate over
   * every user in the deployment and filtered the result in JavaScript, and it is called twice by
   * every role change and every access change.
   */
  async function find(userId: string): Promise<Person | undefined> {
    const { people } = await list({ id: userId, limit: 1 });
    return people[0];
  }

  return {
    list,
    find,

    async avatar(userId) {
      const [row] = await database
        .select({ image: users.avatarImage })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.image ?? null;
    },

    async setAvatar(userId, image) {
      await database
        .update(users)
        .set({ avatarImage: image, updatedAt: new Date() })
        .where(eq(users.id, userId));
    },

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

      /*
       * After the transaction, and deliberately not inside it.
       *
       * Retiring a credential is a write to the vault plus an audit row, and the vault is reached
       * through its own interface rather than this transaction's handle. Holding the person's removal
       * open until that finishes would make an unrelated failure able to undo the deny-list row and
       * the session deletion, which are the two things that must not fail to stick.
       *
       * So the order is: stop them getting in, then stop us holding their secret. If the second half
       * throws, the first is already done and the audit trail shows a removal with no retirement
       * beside it — which is the honest record of what happened, and is recoverable by removing them
       * again.
       */
      await retireOwnedCredentials?.(userId, revokedBy);
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
