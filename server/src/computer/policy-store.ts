/**
 * The policy the gateway is currently enforcing, and the ability to change it while running.
 *
 * It survives a restart. A rule held only in memory vanishes the next time the process comes up, and
 * the trail shows it being added without showing that it stopped applying. A reader would believe a
 * boundary held at a moment when it did not, and a form going through after a restart is
 * indistinguishable from a rule that never applied.
 *
 * Memory is the cache, and the table is the record. The gateway asks for the policy on every single
 * action, so `get` stays synchronous and reads from memory; the write goes through to the database
 * and the memory copy is only updated once it has. A store that answered from the database on every
 * click would put a query on the path of every keystroke a Bot makes.
 *
 * Memory is a cache of a shared record, not a per-process copy of it. OpenBot runs several servers
 * behind a load balancer, and an administrator's new rule arrives at exactly one of them. Kept only
 * in that process, the rule applies to roughly one action in N while the admin screen and the audit
 * row both report success, which is the boundary silently not applying: the failure this whole file
 * exists to prevent, in a different shape. So a write announces itself on Postgres and every server
 * re-reads. Same mechanism as channel activity, for the same reason.
 *
 * Without a database it still works in memory. Tests that only care about decision logic do not need
 * Postgres.
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { actionPolicy } from "../db/schema";
import type { ActionPolicy } from "./policy";

/** There is one boundary per deployment, so there is one row. */
const CURRENT = "current";

/**
 * What a server announces on when the boundary changes, and what every server listens to.
 *
 * The payload is deliberately empty: it says "re-read", not what to read. A rule list can outgrow
 * NOTIFY's 8000-byte cap, and a listener that took the payload as truth would be enforcing whatever
 * fitted rather than what was saved.
 */
export const ACTION_POLICY_TOPIC = "action_policy_changed";

/**
 * What a deployment allows when it has not said otherwise.
 *
 * Permissive, and written down rather than implied. The policy engine is fail-closed: an absent
 * policy denies, and a broken rule denies. This default is a separate decision, and it is deliberately
 * an explicit `allow` rather than a special "unconfigured" case, because a Bot that can look at a page
 * and touch nothing is not a product, and the first thing a person does is ask it to fill something in.
 *
 * Out of the box, OpenBot lets a Bot act, records every action and gives an administrator somewhere
 * to write the first restriction.
 */
export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  mode: "enforce",
  deny: [],
  allow: ["true"],
};

export type PolicyStore = {
  /** Synchronous on purpose: this is asked on every action. */
  get: () => ActionPolicy;
  /** Persisted before the in-memory copy changes, so a reported success is a saved rule. */
  set: (policy: ActionPolicy, by?: string) => Promise<void>;
  /** Back to what configuration says, forgetting the saved one. */
  reset: () => Promise<void>;
  /** Read the saved policy at boot. Returns where the live policy came from. */
  load: () => Promise<"the database" | "configuration">;
  /**
   * Re-read because another server changed it.
   *
   * Separate from `load` so the caller reads as what it is. `load` reports where the policy came
   * from for the boot audit row; this is the running deployment keeping up.
   */
  refresh: () => Promise<void>;
};

export function createPolicyStore(
  initial: ActionPolicy,
  /** Absent keeps everything in memory, which is what a test without a database wants. */
  database?: Database,
): PolicyStore {
  const configured = clone(initial);
  let current = clone(initial);

  return {
    get: () => current,

    set: async (policy, by) => {
      const next = clone(policy);
      if (database) {
        // Written before it is enforced. If the write fails this throws and the caller reports a
        // failure, which is the honest outcome: an administrator who is told a rule was saved must
        // not be enforcing a rule that will disappear at the next restart.
        await database
          .insert(actionPolicy)
          .values({
            id: CURRENT,
            mode: next.mode,
            deny: next.deny,
            allow: next.allow,
            updatedBy: by ?? null,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: actionPolicy.id,
            set: {
              mode: next.mode,
              deny: next.deny,
              allow: next.allow,
              updatedBy: by ?? null,
              updatedAt: new Date(),
            },
          });
      }
      current = next;

      // Announced after the row is written, so a server that re-reads on this signal finds the new
      // rule rather than the old one. Every server hears it, including this one, which re-reads and
      // arrives at what it already has.
      if (database) await announce(database);
    },

    reset: async () => {
      // The saved policy is removed rather than overwritten with the configured one, so "reset" means
      // this deployment has no boundary of its own again, and changing what configuration says then
      // changes what it enforces, which is what an operator expects of a reset.
      if (database) {
        await database.delete(actionPolicy).where(eq(actionPolicy.id, CURRENT));
      }
      current = clone(configured);
      if (database) await announce(database);
    },

    load: async () => {
      if (!database) return "configuration";
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);
      if (!row) return "configuration";

      current = {
        mode: row.mode as ActionPolicy["mode"],
        deny: [...row.deny],
        allow: [...row.allow],
      };
      return "the database";
    },

    refresh: async () => {
      if (!database) return;
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);

      // No row means somebody reset it, and reset means this deployment goes back to what
      // configuration says. Leaving the last saved rules in memory here would make a reset apply on
      // the server that served it and nowhere else, which is the bug this function exists to fix.
      current = row
        ? {
            mode: row.mode as ActionPolicy["mode"],
            deny: [...row.deny],
            allow: [...row.allow],
          }
        : clone(configured);
    },
  };
}

/**
 * Tell every server the boundary moved.
 *
 * Never fatal. The rule is already saved and this process is already enforcing it, so a failed
 * announcement costs the other servers their update until their next restart, which is worth a loud
 * log and is not worth failing a write an administrator has been told succeeded.
 */
async function announce(database: Database): Promise<void> {
  try {
    await database.execute(sql`select pg_notify(${ACTION_POLICY_TOPIC}, '')`);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "action-policy-notify-failed",
        note: "The boundary was saved but other servers were not told. They keep enforcing the previous rules until they restart.",
        error: String(error),
      }),
    );
  }
}

function clone(policy: ActionPolicy): ActionPolicy {
  return {
    mode: policy.mode,
    deny: [...policy.deny],
    allow: [...policy.allow],
  };
}

/**
 * Validate a policy that arrived over HTTP.
 *
 * Rejects rather than coerces. A policy is the thing standing between a Bot and somebody's live
 * website, and "we accepted your rule but not in the shape you wrote it" is the one behaviour that
 * must never happen here: an operator would believe a restriction is in force when it is not.
 *
 * Expressions are NOT validated for correctness on the way in, only for being strings. Whether a rule
 * is meaningful is the policy engine's business, it fails closed there, and pre-validating here would
 * mean two parsers to keep in agreement.
 */
export function parseActionPolicy(
  input: unknown,
): { ok: true; policy: ActionPolicy } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "A policy must be an object." };
  }
  const candidate = input as Record<string, unknown>;

  const mode = candidate.mode;
  if (mode !== "enforce" && mode !== "dry-run") {
    return {
      ok: false,
      error: 'mode must be "enforce" or "dry-run".',
    };
  }

  const lists: Record<"deny" | "allow", string[]> = { deny: [], allow: [] };
  for (const key of ["deny", "allow"] as const) {
    const value = candidate[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: `${key} must be a list of expressions.` };
    }
    lists[key] = value as string[];
  }

  return { ok: true, policy: { mode, deny: lists.deny, allow: lists.allow } };
}
