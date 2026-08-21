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
 * That cache is per process, and OpenBot runs as several. A rule saved by the process that answered
 * the administrator would otherwise be enforced by that process alone, while every other replica went
 * on deciding with the list it read at boot: the screen reports success, the trail reports success,
 * and the boundary applies to roughly one action in N. So a change is announced through Postgres and
 * every replica re-reads the row. See `startActionPolicyListener` below.
 *
 * Without a database it still works in memory. Tests that only care about decision logic do not need
 * Postgres.
 */
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import { actionPolicy } from "../db/schema";
import type { ActionPolicy } from "./policy";

/** There is one boundary per deployment, so there is one row. */
const CURRENT = "current";

/**
 * How a replica hears that the boundary changed under it.
 *
 * The announcement carries no policy. It is a nudge to re-read the row, so two changes that overtake
 * each other still converge on what the table says rather than on whichever payload landed last, and
 * a replica that was disconnected recovers by reading the same row when it subscribes again. The
 * table is the record; this is only how a process learns it is out of date sooner than its next
 * restart.
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
        //
        // One transaction with the announcement, so the announcement is delivered on commit and a
        // write that rolled back is never announced. A single upsert of a single row is also what
        // keeps two administrators saving at once from producing two boundaries: the row is the one
        // decision, the last commit wins it, and every replica re-reads that same row.
        await database.transaction(async (transaction) => {
          await transaction
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
          await announce(transaction);
        });
      }
      current = next;
    },

    reset: async () => {
      // The saved policy is removed rather than overwritten with the configured one, so "reset" means
      // this deployment has no boundary of its own again, and changing what configuration says then
      // changes what it enforces, which is what an operator expects of a reset.
      if (database) {
        // Announced like a set is, and for the same reason: a rule that cannot be lifted everywhere
        // is no better than one that cannot be added everywhere. A replica that kept the old list
        // would go on refusing an action an administrator has been told is allowed again.
        await database.transaction(async (transaction) => {
          await transaction
            .delete(actionPolicy)
            .where(eq(actionPolicy.id, CURRENT));
          await announce(transaction);
        });
      }
      current = clone(configured);
    },

    load: async () => {
      if (!database) return "configuration";
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);
      if (!row) {
        // No row means this deployment has no boundary of its own, which is a state a running
        // process can arrive at: another replica reset it a moment ago. Falling back to the
        // configured default here is what makes a reset reach a process that was already running,
        // rather than leaving it enforcing a rule that no longer exists anywhere.
        current = clone(configured);
        return "configuration";
      }

      current = {
        mode: row.mode as ActionPolicy["mode"],
        deny: [...row.deny],
        allow: [...row.allow],
      };
      return "the database";
    },
  };
}

/** Tell every replica, including this one, that the row it caches is stale. */
async function announce(executor: {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  await executor.execute(sql`select pg_notify(${ACTION_POLICY_TOPIC}, '')`);
}

export type ActionPolicyListener = { stop: () => Promise<void> };

/**
 * The subscription this needs, which is all of a driver connection it uses.
 *
 * Narrow because a test then stands in for the connection without standing in for Postgres, and the
 * subscription logic under test stays the one that runs in production.
 */
export type PolicyNotifications = {
  listen: (
    topic: string,
    onNotify: (payload: string) => void,
    onListen?: () => void,
  ) => Promise<unknown>;
  end: () => Promise<unknown>;
};

/**
 * Keep this replica's cached policy in step with the row every replica shares.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back.
 *
 * Every notification re-reads the row rather than trusting a payload, and the same re-read happens
 * whenever the subscription is established. That second part is what keeps a missed notification
 * from being permanent: the driver says `LISTEN` again after a dropped connection, and anything
 * announced while it was down is picked up from the table then, instead of at the next restart.
 */
export async function startActionPolicyListener(
  databaseUrl: string,
  store: PolicyStore,
  connect: (databaseUrl: string) => PolicyNotifications = (url) =>
    postgres(url, { max: 1 }),
): Promise<ActionPolicyListener> {
  const connection = connect(databaseUrl);

  const reread = () => {
    void store.load().catch((error: unknown) => {
      // Said out loud rather than swallowed. Unlike a missed channel event, which the next refetch
      // corrects, a policy this process failed to re-read means it is deciding actions against a
      // boundary that is no longer the deployment's. It will be corrected by the next announcement
      // or the next reconnect, and until then somebody should be able to see why it was not.
      console.error(
        JSON.stringify({
          type: "action-policy-reload-failed",
          message: error instanceof Error ? error.message : String(error),
          note: "This process is still enforcing the policy it last read. The next announcement or reconnect re-reads it.",
        }),
      );
    });
  };

  await connection.listen(ACTION_POLICY_TOPIC, reread, reread);

  return {
    stop: async () => {
      await connection.end();
    },
  };
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
