/**
 * What this deployment does when the company's directory, through SCIM, changes somebody.
 *
 * SCIM is served by Intelligence's organization directory (auth/scim.ts), which records what the
 * directory said: a person made, a removal of a deactivated person's address, that removal lifted.
 * What only this deployment can do it does here, once per change, on one replica:
 *
 * - A person the directory provisioned arrives (the projection inserted their row): the configured
 *   administrator floor applies to them, as it did to anybody SCIM made, and `person.provisioned` is
 *   written to the trail.
 * - A removal made by SCIM: their sessions end (and with them their Recorders), what they connected is
 *   retired and their Bots' computers stop; `person.deprovisioned` is written.
 * - That removal lifted: `person.reprovisioned` is written.
 *
 * `reconcile` compares Intelligence's SCIM removals with the ledger of the ones acted on
 * (`directory_removal_reactions`): each new one is claimed by inserting it, so of several replicas
 * hearing the same announcement exactly one acts. It runs after every SCIM write this deployment
 * forwards (before the directory is answered), on every removal announcement, and on a timer, which is
 * what catches a change made at Intelligence's own address while no replica was listening.
 */
import { eq, notInArray, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../../audit";
import { applyConfiguredAdmin } from "../../auth/roles";
import type { Database } from "../../db/client";
import { directoryRemovalReactions, users } from "../../db/schema";
import type { DirectoryClient } from "./client";
import type { Person } from "./types";

const SCIM = "scim:";
const RECONCILE_INTERVAL_MS = 60_000;

export type ScimReactions = {
  /** Act on every SCIM removal not acted on yet, and on every one lifted since. */
  reconcile(): Promise<void>;
  /** A person new to this deployment arrived from Intelligence. */
  arrived(person: Person): Promise<void>;
  start(): void;
  stop(): void;
};

export function createScimReactions(deps: {
  database: Database;
  client: Pick<DirectoryClient, "allRemovals">;
  initialAdminEmails: readonly string[];
  /** End every session of this person, through Better Auth, so their Recorders end with them. */
  endSessions: (userId: string) => Promise<void>;
  /** Retire what they connected and stop their Bots' computers. */
  offboard: (userId: string, by: string) => Promise<void>;
  auditStore?: AuditStore;
}): ScimReactions {
  const { database } = deps;
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const audit = async (event: Parameters<typeof recordAuditEvent>[1]) => {
    if (!deps.auditStore) return;
    await recordAuditEvent(deps.auditStore, event).catch((error) =>
      console.error(
        JSON.stringify({
          type: "scim-audit-write-failed",
          eventType: event.eventType,
          error: String(error),
        }),
      ),
    );
  };

  const personWith = async (email: string) =>
    (
      await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
        .limit(1)
    )[0];

  const once = async () => {
    const removals = (await deps.client.allRemovals()).filter((removal) =>
      removal.removedBy.startsWith(SCIM),
    );
    for (const removal of removals) {
      // Claimed by inserting it: of every replica that hears it, only one gets a row back.
      const claimed = await database
        .insert(directoryRemovalReactions)
        .values({ email: removal.email, removedAt: removal.removedAt })
        .onConflictDoUpdate({
          target: directoryRemovalReactions.email,
          set: { removedAt: removal.removedAt, actedAt: new Date() },
          setWhere: sql`${directoryRemovalReactions.removedAt} <> ${removal.removedAt}`,
        })
        .returning({ email: directoryRemovalReactions.email });
      if (claimed.length === 0) continue;
      const person = await personWith(removal.email);
      if (!person) continue;
      await deps.endSessions(person.id);
      await deps.offboard(person.id, removal.removedBy);
      await audit({
        eventType: "person.deprovisioned",
        targetType: "person",
        targetId: person.id,
        payload: {
          email: person.email,
          via: "SCIM",
          note: "Sessions ended, address deny-listed, connector credentials retired, computers stopped.",
        },
      });
    }
    // Acted on before and no longer removed: the directory reactivated them.
    const lifted = await database
      .delete(directoryRemovalReactions)
      .where(
        removals.length > 0
          ? notInArray(
              directoryRemovalReactions.email,
              removals.map((removal) => removal.email),
            )
          : sql`true`,
      )
      .returning({ email: directoryRemovalReactions.email });
    for (const { email } of lifted) {
      const person = await personWith(email);
      if (!person) continue;
      await audit({
        eventType: "person.reprovisioned",
        targetType: "person",
        targetId: person.id,
        payload: { email: person.email, via: "SCIM" },
      });
    }
  };

  const reconcile = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again);
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    reconcile,

    async arrived(person) {
      if (!person.provisionedBy?.startsWith(SCIM)) return;
      await applyConfiguredAdmin(database, person.id, deps.initialAdminEmails);
      const [row] = await database
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, person.id))
        .limit(1);
      await audit({
        eventType: "person.provisioned",
        targetType: "person",
        targetId: person.id,
        payload: {
          email: person.email,
          via: "SCIM",
          role: row?.role ?? "user",
        },
      });
    },

    start() {
      timer = setInterval(() => {
        reconcile().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "scim-reconcile-failed",
              note: "Tried again on the next tick.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, RECONCILE_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
    },
  };
}

let installed: ScimReactions | undefined;

export function installScimReactions(reactions: ScimReactions): ScimReactions {
  installed = reactions;
  return reactions;
}

/** The process's SCIM reactions, once boot has made them; undefined before. */
export function scimReactions(): ScimReactions | undefined {
  return installed;
}
