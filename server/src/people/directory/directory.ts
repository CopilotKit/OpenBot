/**
 * The people of this deployment: held by Intelligence's organization directory, projected into the
 * local `users` table.
 *
 * WHY A PROJECTION. About 56 tables name a person by a foreign key to `users`, and the session and
 * the request guard read a person on every request. So the row stays, as this deployment's copy of the
 * person Intelligence holds, and every one of those tables keeps its parent. A person Intelligence
 * deletes for good is deleted here, and the foreign keys' own `ON DELETE CASCADE` takes their rows with
 * them, exactly as removing the row always did.
 *
 * WHO WRITES WHAT.
 * - Everything OpenBot decides about a person (their role, their preferences, onboarding, when they
 *   last signed in, a display name they chose) is written to Intelligence first, and the row is
 *   updated from Intelligence's answer: `update`, `create`, `purge`.
 * - What Better Auth writes (a first sign-in, the name and picture an identity provider sends, a
 *   verified address, the groups the company's directory sets) it writes to the row, inside its own
 *   transactions, and the row is marked pending (`directory_version` null). After the write commits it
 *   is pushed to Intelligence (`push`, called from auth/directory-adapter.ts), and a sweep retries any
 *   push that failed. No OpenBot transaction is ever held open across an Intelligence call.
 *
 * HOW IT STAYS FRESH. Intelligence announces every change over its realtime gateway; an announcement is
 * followed by a read of that person. Announcements can be lost, so the whole directory is read again
 * whenever the subscription joins (every reconnect) and on a timer. Versions order what arrives: an older
 * copy never replaces a newer one, and a pending row is never overwritten.
 */
import { createHash } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { OpenBotRole } from "../../auth/roles";
import type { Database } from "../../db/client";
import { accounts, directoryBinding, users } from "../../db/schema";
import {
  type DirectoryClient,
  DirectoryVersionConflictError,
  EmailTakenError,
  idempotencyKey,
  normalizeEmail,
  PersonAlreadyExistsError,
  PersonDeletedError,
  PersonMissingError,
} from "./client";
import {
  type DirectoryChangeSubscription,
  subscribeToDirectoryChanges,
} from "./events";
import type {
  DirectoryChange,
  Person,
  PersonChanges,
  PersonDraft,
  Removal,
  SignInIdentity,
} from "./types";

export type PeopleDirectory = {
  /** Read the whole directory into the projection and subscribe to changes. */
  start(): Promise<void>;
  stop(): void;
  /** Whether announcements are arriving: the realtime subscription is joined. */
  subscribed(): boolean;
  client: DirectoryClient;
  /** Make a person in Intelligence, then here. */
  create(draft: PersonDraft, key?: string): Promise<Person>;
  /**
   * Change a person in Intelligence, then here. `change` is given the person as Intelligence holds
   * them and answers what to set, or null for nothing; it runs again when somebody else saved first.
   */
  update(
    id: string,
    change: (current: Person) => PersonChanges | null,
  ): Promise<Person>;
  /** Delete a person for good, in Intelligence and here (and with them every row that names them). */
  purge(id: string): Promise<void>;
  /** Read this person from Intelligence now and bring the row in line. Null when they are gone. */
  refresh(id: string): Promise<Person | null>;
  /** Send a row Better Auth wrote to Intelligence. Null when there was nothing pending. */
  push(id: string): Promise<Person | null>;
  /** Push every pending row. Answers how many were pushed. */
  pushPending(limit?: number): Promise<number>;
  /** Read the whole directory again. */
  resync(): Promise<void>;
  /** Removed addresses. */
  removals: {
    remove(
      email: string,
      removedBy: string,
    ): Promise<{ removal: Removal; created: boolean }>;
    find(email: string): Promise<Removal | null>;
    among(emails: readonly string[]): Promise<Set<string>>;
    /** Lift the removal of `email`, or only when `when` says so of the removal held. True when lifted. */
    lift(email: string, when?: (removal: Removal) => boolean): Promise<boolean>;
  };
};

/** Well inside the hour the gateway keeps a join code alive for; every full read renews it. */
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;
/** How often rows Better Auth wrote, and whose push failed, are pushed again. */
const PUSH_INTERVAL_MS = 30_000;
const CONFLICT_ATTEMPTS = 5;

type UserRow = typeof users.$inferSelect;

/** The identities a person signs in with, from their sign-in accounts here. Never a secret. */
export function signInIdentitiesOf(
  rows: readonly {
    providerId: string;
    accountId: string;
    issuer: string | null;
  }[],
): SignInIdentity[] {
  const identities = new Map<string, SignInIdentity>();
  for (const row of rows) {
    // A CopilotKit organization signs people in with Clerk; Intelligence knows the same person by
    // their Clerk user id, which is the account id here.
    const identity =
      row.providerId === "copilotkit"
        ? { issuer: "clerk", subject: row.accountId }
        : {
            issuer: row.issuer ?? `local:oauth:${row.providerId}`,
            subject: row.accountId,
          };
    identities.set(`${identity.issuer}\u001f${identity.subject}`, identity);
  }
  return [...identities.values()]
    .sort((a, b) =>
      a.issuer === b.issuer
        ? a.subject.localeCompare(b.subject)
        : a.issuer.localeCompare(b.issuer),
    )
    .slice(0, 20);
}

/** The row as Intelligence's person describes it. */
function rowFrom(person: Person) {
  return {
    id: person.id,
    email: person.email,
    name: person.name,
    image: person.image,
    emailVerified: person.emailVerified,
    role: person.role,
    groups: person.groups,
    preferences: person.preferences,
    onboardingStep: person.onboardingStep,
    onboardingCompletedAt: person.onboardingCompletedAt,
    lastSignedInAt: person.lastSignedInAt,
    directoryVersion: person.version,
    directoryPending: false,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
  };
}

const sameIdentities = (
  a: readonly SignInIdentity[],
  b: readonly SignInIdentity[],
) =>
  a.length === b.length &&
  a.every(
    (identity, index) =>
      identity.issuer === b[index]?.issuer &&
      identity.subject === b[index]?.subject,
  );

/** What Better Auth wrote that Intelligence does not have yet. */
function pendingChanges(
  row: UserRow,
  identities: SignInIdentity[],
  current: Person,
): PersonChanges {
  const changes: PersonChanges = {};
  if (normalizeEmail(row.email) !== current.email) changes.email = row.email;
  if ((row.name ?? null) !== current.name) changes.name = row.name ?? null;
  if ((row.image ?? null) !== current.image) changes.image = row.image ?? null;
  if (row.emailVerified !== current.emailVerified)
    changes.emailVerified = row.emailVerified;
  // Groups are the directory's: SCIM sets them in Intelligence, never a write here.
  if (!sameIdentities(identities, current.signInIdentities))
    changes.signInIdentities = identities;
  return changes;
}

/** Same body, same key, from every replica: two pushes of one row are one write. */
function contentKey(operation: string, body: unknown): string {
  return `openbot-directory:${operation}:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function isUniqueViolation(error: unknown): boolean {
  type Driver = { errno?: unknown; code?: unknown };
  for (const candidate of [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ])
    if (candidate?.errno === "23505" || candidate?.code === "23505")
      return true;
  return false;
}

export function createPeopleDirectory(options: {
  client: DirectoryClient;
  database: Database;
  /** The role a person Better Auth made is given, when the row does not say. */
  defaultRole?: (email: string) => OpenBotRole;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  pushIntervalMs?: number;
  /** How announcements are subscribed to. The gateway's, unless a test drives them itself. */
  subscribe?: typeof subscribeToDirectoryChanges;
  /**
   * A person new to this deployment arrived from Intelligence (provisioned by SCIM, made by another
   * replica's sign-in, or by another application). Called on one replica only.
   */
  onArrived?: (person: Person) => Promise<void>;
  /** Something in the directory changed, for listeners beyond the projection (SCIM reactions). */
  onChange?: (change: DirectoryChange) => void;
}): PeopleDirectory {
  const { client, database } = options;
  /** When each person was last confirmed by Intelligence, so a full read can tell a purge from a newcomer. */
  const seenAt = new Map<string, number>();
  let subscription: DirectoryChangeSubscription | undefined;
  let resyncTimer: ReturnType<typeof setInterval> | undefined;
  let pushTimer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;
  let pushing: Promise<number> | undefined;

  /**
   * Bring the row in line with Intelligence's person: insert it when absent, overwrite it when the
   * row reflects an older version. A pending row is left alone: it carries a change Intelligence has
   * not had yet, and its push applies Intelligence's answer.
   */
  const apply = async (person: Person, confirmedAt = Date.now()) => {
    seenAt.set(person.id, Math.max(seenAt.get(person.id) ?? 0, confirmedAt));
    const row = rowFrom(person);
    let written: { inserted: boolean }[] = [];
    try {
      written = await database
        .insert(users)
        .values(row)
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email: row.email,
            name: row.name,
            image: row.image,
            emailVerified: row.emailVerified,
            role: row.role,
            groups: row.groups,
            preferences: row.preferences,
            onboardingStep: row.onboardingStep,
            onboardingCompletedAt: row.onboardingCompletedAt,
            lastSignedInAt: row.lastSignedInAt,
            directoryVersion: row.directoryVersion,
            directoryPending: false,
            updatedAt: row.updatedAt,
          },
          setWhere: and(
            eq(users.directoryPending, false),
            sql`coalesce(${users.directoryVersion}, 0) < ${person.version}`,
          ),
        })
        // `xmax` is 0 on a row this statement inserted: somebody new to this deployment.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another row here holds the address: a person Better Auth made a moment ago whose push has
      // not reached Intelligence yet. Their push meets the same address and says so.
      console.error(
        JSON.stringify({
          type: "directory-projection-email-conflict",
          personId: person.id,
          note: "Intelligence holds a person whose address another row here already has. The row was not written.",
        }),
      );
    }
    // Only the replica whose statement inserted the row hears of the newcomer: the rows are shared.
    if (written[0]?.inserted && options.onArrived) {
      try {
        await options.onArrived(person);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "directory-arrival-failed",
            personId: person.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  /** A person Intelligence deleted for good: their row goes, and the cascades take every row naming them. */
  const forget = async (id: string) => {
    seenAt.delete(id);
    const removed = await database
      .delete(users)
      .where(and(eq(users.id, id), isNotNull(users.directoryVersion)))
      .returning({ id: users.id });
    if (removed.length > 0)
      console.warn(
        JSON.stringify({
          type: "person-purged-locally",
          personId: id,
          note: "Intelligence deleted this person for good; their row and every row that named them were removed.",
        }),
      );
  };

  const refresh = async (id: string): Promise<Person | null> => {
    const startedAt = Date.now();
    const person = await client.getPerson(id);
    if (!person) {
      await forget(id);
      return null;
    }
    await apply(person, startedAt);
    return person;
  };

  const heard = async (change: DirectoryChange) => {
    options.onChange?.(change);
    if (change.kind !== "person") return;
    try {
      await refresh(change.id);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "directory-change-read-failed",
          personId: change.id,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const readAll = async () => {
    // Read here BEFORE Intelligence is asked, and that order is the safety: a row with a version was
    // written from Intelligence, so its person was there before this read; absent from the complete
    // listing that follows means it was purged since. Pending rows are never candidates.
    const candidates = await database
      .select({ id: users.id })
      .from(users)
      .where(isNotNull(users.directoryVersion));
    const startedAt = Date.now();
    const { people, joinCode } = await client.allPeople({
      includeDeleted: true,
    });
    const listed = new Set<string>();
    for (const person of people) {
      listed.add(person.id);
      await apply(person, startedAt);
    }
    for (const { id } of candidates) {
      if (listed.has(id)) continue;
      if ((seenAt.get(id) ?? 0) >= startedAt) continue;
      await forget(id);
    }
    const subscribed = subscription?.joinCode();
    if (subscribed && subscribed !== joinCode) subscription?.renew();
  };

  const resync = (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      try {
        do {
          resyncAgain = false;
          await readAll();
        } while (resyncAgain);
      } finally {
        resyncing = undefined;
      }
    })();
    return resyncing;
  };

  const identitiesFor = async (id: string) =>
    signInIdentitiesOf(
      await database
        .select({
          providerId: accounts.providerId,
          accountId: accounts.accountId,
          issuer: accounts.issuer,
        })
        .from(accounts)
        .where(eq(accounts.userId, id)),
    );

  const draftFrom = (
    row: UserRow,
    identities: SignInIdentity[],
  ): PersonDraft => ({
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    image: row.image ?? null,
    emailVerified: row.emailVerified,
    role: row.role ?? options.defaultRole?.(row.email) ?? "user",
    groups: [...new Set(row.groups)].sort(),
    preferences: row.preferences,
    onboardingStep: row.onboardingStep,
    onboardingCompletedAt: row.onboardingCompletedAt,
    lastSignedInAt: row.lastSignedInAt,
    signInIdentities: identities,
    createdAt: row.createdAt,
  });

  /**
   * Mark the row as reflecting `person`, but only if it is still the row that was pushed: a later
   * write by Better Auth leaves it pending, and that write's own push follows.
   */
  const settle = async (person: Person, pushed: UserRow) => {
    seenAt.set(person.id, Date.now());
    const row = rowFrom(person);
    await database
      .update(users)
      .set({
        email: row.email,
        name: row.name,
        image: row.image,
        emailVerified: row.emailVerified,
        role: row.role,
        groups: row.groups,
        preferences: row.preferences,
        onboardingStep: row.onboardingStep,
        onboardingCompletedAt: row.onboardingCompletedAt,
        lastSignedInAt: row.lastSignedInAt,
        directoryVersion: row.directoryVersion,
        directoryPending: false,
        updatedAt: pushed.updatedAt,
      })
      .where(
        and(
          eq(users.id, person.id),
          eq(users.directoryPending, true),
          // To the millisecond, as the row was read: a time Postgres wrote itself (`now()`) carries
          // microseconds the read dropped.
          sql`date_trunc('milliseconds', ${users.updatedAt}) = ${pushed.updatedAt}`,
        ),
      );
  };

  const push = async (id: string): Promise<Person | null> => {
    const [row] = await database
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row?.directoryPending) return null;
    const identities = await identitiesFor(id);
    let current = await client.getPerson(id);
    if (!current && row.directoryVersion !== null) {
      // Intelligence had this person and no longer does: deleted for good there while this change
      // waited. The deletion wins: the row goes, as it would have, and the person is not made again.
      await forget(id);
      return null;
    }
    if (!current) {
      const draft = draftFrom(row, identities);
      try {
        let created = await client.createPerson(
          draft,
          contentKey("create", draft),
        );
        // The key is made from the request so replicas agree on it, which also means a person
        // purged and pushed again the same day would get the first create's answer replayed with
        // nothing made. Asked once, and made again under a key of its own if so.
        if (!(await client.getPerson(id)))
          created = await client.createPerson(
            draft,
            idempotencyKey("create-person-again"),
          );
        await settle(created, row);
        return created;
      } catch (error) {
        if (error instanceof EmailTakenError) {
          console.error(
            JSON.stringify({
              type: "directory-push-email-taken",
              personId: id,
              note: "Intelligence already holds another person with this address, so this one was not added. It stays here, pending, until the two are reconciled.",
            }),
          );
          return null;
        }
        if (!(error instanceof PersonAlreadyExistsError)) throw error;
        current = await client.getPerson(id);
        if (!current) throw error;
      }
    }
    for (let attempt = 1; ; attempt++) {
      const changes = pendingChanges(row, identities, current);
      if (Object.keys(changes).length === 0 || current.deletedAt) {
        await settle(current, row);
        return current;
      }
      try {
        const updated = await client.updatePerson(
          id,
          current.version,
          changes,
          contentKey("push", { id, version: current.version, changes }),
        );
        await settle(updated, row);
        return updated;
      } catch (error) {
        if (error instanceof PersonDeletedError) {
          const deleted = await client.getPerson(id);
          if (deleted) await settle(deleted, row);
          return deleted;
        }
        if (
          !(error instanceof DirectoryVersionConflictError) ||
          attempt >= CONFLICT_ATTEMPTS
        )
          throw error;
        const again = await client.getPerson(id);
        if (!again) throw new PersonMissingError(id);
        current = again;
      }
    }
  };

  const pushPending = (limit = 100): Promise<number> => {
    if (pushing) return pushing;
    pushing = (async () => {
      let pushed = 0;
      try {
        const pending = await database
          .select({ id: users.id })
          .from(users)
          .where(eq(users.directoryPending, true))
          .orderBy(users.createdAt)
          .limit(limit);
        for (const { id } of pending) {
          try {
            if (await push(id)) pushed += 1;
          } catch (error) {
            console.warn(
              JSON.stringify({
                type: "directory-push-failed",
                personId: id,
                note: "The row stays pending and is pushed again on the next sweep.",
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }
        return pushed;
      } finally {
        pushing = undefined;
      }
    })();
    return pushing;
  };

  const directory: PeopleDirectory = {
    client,

    async start() {
      await bindToProject(database, await client.scope());
      if (options.gatewayWsUrl) {
        subscription = (options.subscribe ?? subscribeToDirectoryChanges)({
          client,
          gatewayWsUrl: options.gatewayWsUrl,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            resync().catch((error: unknown) =>
              console.warn(
                JSON.stringify({
                  type: "directory-resync-failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          },
        });
      }
      await resync();
      resyncTimer = setInterval(() => {
        resync().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "directory-resync-failed",
              note: "Still serving the people this deployment last read.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      resyncTimer.unref?.();
      pushTimer = setInterval(() => {
        void pushPending();
      }, options.pushIntervalMs ?? PUSH_INTERVAL_MS);
      pushTimer.unref?.();
    },

    stop() {
      clearInterval(resyncTimer);
      clearInterval(pushTimer);
      subscription?.stop();
    },

    subscribed: () => subscription?.joinCode() != null,

    async create(draft, key = idempotencyKey("create-person")) {
      const person = await client.createPerson(draft, key);
      await apply(person);
      return person;
    },

    async update(id, change) {
      // A row Better Auth wrote and Intelligence has not had yet goes first, so the change below is
      // made to the person as this deployment knows them.
      await push(id);
      let current = await client.getPerson(id);
      if (!current) throw new PersonMissingError(id);
      for (let attempt = 1; ; attempt++) {
        const changes = change(current);
        if (!changes || Object.keys(changes).length === 0) {
          await apply(current);
          return current;
        }
        try {
          const updated = await client.updatePerson(
            id,
            current.version,
            changes,
            idempotencyKey("update-person"),
          );
          await apply(updated);
          return updated;
        } catch (error) {
          if (
            !(error instanceof DirectoryVersionConflictError) ||
            attempt >= CONFLICT_ATTEMPTS
          )
            throw error;
          const again = await client.getPerson(id);
          if (!again) throw new PersonMissingError(id);
          current = again;
        }
      }
    },

    async purge(id) {
      await client.purgePerson(id, idempotencyKey("purge-person"));
      seenAt.delete(id);
      await database.delete(users).where(eq(users.id, id));
    },

    refresh,
    push,
    pushPending,
    resync,

    removals: {
      remove: (email, removedBy) =>
        client.putRemoval(
          normalizeEmail(email),
          removedBy,
          idempotencyKey("remove-address"),
        ),
      find: (email) => client.getRemoval(email),
      async among(emails) {
        if (emails.length === 0) return new Set();
        return new Set(
          (await client.removalsAmong(emails)).map((removal) => removal.email),
        );
      },
      async lift(email, when) {
        const held = await client.getRemoval(email);
        if (!held) return false;
        if (when && !when(held)) return false;
        try {
          return await client.deleteRemoval(
            email,
            idempotencyKey("lift-removal"),
            held.version,
          );
        } catch (error) {
          // Removed again since it was read: that newer removal stands.
          if (error instanceof DirectoryVersionConflictError) return false;
          throw error;
        }
      },
    },
  };
  return directory;
}

/** The database's people belong to another Intelligence project than the one configured. */
export class DirectoryProjectMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryProjectMismatchError";
  }
}

/**
 * Bind this database to the Intelligence project its people belong to, the first time; refuse, loudly,
 * a start against any other.
 *
 * The projection takes a person Intelligence does not hold for one deleted there, and deletes them,
 * with every row that names them. Started against another project, every person here is one that
 * project does not hold. So the database remembers its project, and a deployment pointed elsewhere
 * stops before reading anything.
 */
export async function bindToProject(
  database: Database,
  scope: { organizationId: string; projectId: string },
): Promise<void> {
  await database
    .insert(directoryBinding)
    .values({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    })
    .onConflictDoNothing();
  const [bound] = await database.select().from(directoryBinding).limit(1);
  if (
    bound &&
    (bound.organizationId !== scope.organizationId ||
      bound.projectId !== scope.projectId)
  ) {
    throw new DirectoryProjectMismatchError(
      `This database's people belong to Intelligence project ${bound.projectId} of organization ${bound.organizationId}, but INTELLIGENCE_API_KEY is a key for project ${scope.projectId} of organization ${scope.organizationId}. Starting would take every person here for one deleted in that project and remove them, so the server has stopped and nothing was changed. Set INTELLIGENCE_API_KEY to a key for project ${bound.projectId}, or start this deployment on an empty database.`,
    );
  }
}

let installed: PeopleDirectory | undefined;

/** Make this the directory every person read and write in this process goes through. */
export function installPeopleDirectory(
  directory: PeopleDirectory,
): PeopleDirectory {
  installed = directory;
  return directory;
}

/**
 * The people directory, as this process holds it.
 *
 * Throws when nothing installed one, rather than writing a person only here: a person Intelligence
 * never heard of is one nobody else can see, and nothing about it would say why.
 */
export function people(): PeopleDirectory {
  if (!installed) {
    throw new Error(
      "No people directory is installed. The server installs one at boot (people/directory); a test installs the one in tests/support/people.ts.",
    );
  }
  return installed;
}

/** Whether one is installed, for the few callers that also run before boot finishes. */
export function peopleDirectoryInstalled(): boolean {
  return installed !== undefined;
}
