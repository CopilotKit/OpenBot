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
 *
 * TWO SOURCES, ONE ANSWER. What the gateway enforces is the operator's own policy plus the ceilings
 * that came with imported Bots, and those two are stored apart on purpose. `set` replaces the whole
 * `deny` array and the Boundaries screen posts back a snapshot of what it last read, with no version
 * column between them, so a per-Bot clause written into `action_policy.deny` is erased by the next
 * administrator who saves an unrelated change — a lost update that silently uncages an imported Bot
 * with nothing anywhere saying it happened. The clauses live in `template_boundaries`, an import
 * writes them and a retraction retires them, and this file composes the two lists for evaluation and
 * for nothing else. Different storage makes that lost update unrepresentable rather than unlikely.
 */
import { asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { actionPolicy, templateBoundaries } from "../db/schema";
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
  /**
   * What is in force: the operator's policy with every live template clause appended to `deny`.
   *
   * Synchronous on purpose, because this is asked on every action. The composed value is built when
   * either half changes rather than on each call, so a Bot's keystroke costs a property read and not
   * two array copies.
   */
  get: () => ActionPolicy;
  /**
   * Persisted before the in-memory copy changes, so a reported success is a saved rule.
   *
   * Only the operator's own rules are ever written. A clause that came from an import is dropped from
   * the incoming array rather than saved — see the comment on the implementation.
   */
  set: (policy: ActionPolicy, by?: string) => Promise<void>;
  /** Back to what configuration says, forgetting the saved one. Template ceilings are untouched. */
  reset: () => Promise<void>;
  /** Read the saved policy and the live template clauses at boot. Returns where the policy came from. */
  load: () => Promise<"the database" | "configuration">;
  /**
   * Re-read because another server changed it, or because an import landed here.
   *
   * Separate from `load` so the caller reads as what it is. `load` reports where the policy came
   * from for the boot audit row; this is the running deployment keeping up. Both halves are re-read,
   * because an import announces on the same topic an administrator's save does.
   */
  refresh: () => Promise<void>;
};

export function createPolicyStore(
  initial: ActionPolicy,
  /** Absent keeps everything in memory, which is what a test without a database wants. */
  database?: Database,
): PolicyStore {
  const configured = clone(initial);
  /** What an operator wrote. This, and only this, is what `set` saves. */
  let stored = clone(initial);
  /**
   * The clauses imports brought with them, in force.
   *
   * Held in memory beside the operator's rules for the reason the whole file is built this way: the
   * gateway asks on every action, so a query here would be a query per keystroke. Empty until `load`
   * has run, which is a deliberate direction to be wrong in only at boot — `index.ts` loads before
   * it serves, and a clause that has not been read yet is one this process cannot enforce, so the
   * read is not allowed to be quietly skipped. See `readGenerated`.
   */
  let generated: readonly string[] = [];
  /**
   * The two, composed once per change rather than once per action.
   *
   * Rebuilt by `settle` whenever either half moves. A `get` that composed on each call would put two
   * array copies on the path of every click a Bot makes, and would also hand a different object out
   * every time to callers that reasonably keep the one they were given.
   */
  let composed = compose(stored, generated);

  /** Commit both halves at once, then rebuild what `get` hands out. */
  function settle(next: ActionPolicy, clauses: readonly string[]): void {
    stored = next;
    generated = clauses;
    composed = compose(stored, generated);
  }

  /**
   * Every template clause that is still in force, in a stable order.
   *
   * Ordered rather than left to the planner, because a refusal names the clause that matched it in
   * the audit row: two servers enforcing the same clauses must also blame the same one, and
   * "whichever the sequential scan reached first" is not a promise PostgreSQL makes across replicas
   * or after a vacuum.
   *
   * A failure here is NOT swallowed. Returning an empty list when the read fails would run the
   * deployment with every imported Bot uncaged, reported nowhere — precisely the silent uncaging the
   * separate table exists to prevent. The callers decide what to do with the throw: `load` lets it
   * reach boot, and `refresh` keeps what it already had, which is the safe direction for both an
   * added clause and a retracted one.
   */
  async function readGenerated(): Promise<readonly string[]> {
    if (!database) return [];
    const rows = await database
      .select({ expression: templateBoundaries.expression })
      .from(templateBoundaries)
      .where(isNull(templateBoundaries.removedAt))
      .orderBy(
        asc(templateBoundaries.agentId),
        asc(templateBoundaries.expression),
      );
    return rows.map((row) => row.expression);
  }

  return {
    get: () => composed,

    set: async (policy, by) => {
      /*
       * A clause an import wrote can arrive back here, and it must not be saved.
       *
       * `get` composes, so the Boundaries screen reads the template clauses along with the
       * operator's own and posts the whole array back on the next save. Written into
       * `action_policy.deny` they would become operator rules: retraction would no longer remove
       * them, and the next unrelated save on a server whose copy was a moment stale would drop them
       * for good. Filtered rather than refused, because refusing would break every save an
       * administrator makes on a deployment that has imported a single Bot.
       *
       * The cost is small and worth naming: an operator who deliberately types a rule that is
       * character-identical to a generated clause does not get their own copy of it, and their rule
       * disappears the day that import is retracted. The clause is enforced throughout either way.
       */
      const fromImports = new Set(generated);
      const next = clone(policy);
      next.deny = next.deny.filter(
        (expression) => !fromImports.has(expression),
      );
      if (database) {
        // Written before it is enforced. If the write fails this throws and the caller reports a
        // failure, which is the honest outcome: an administrator who is told a rule was saved must
        // not be enforcing a rule that will disappear at the next restart.
        //
        // The announcement goes in the same transaction, so it is delivered on commit: a write that
        // rolls back announces nothing, and there is no window where the row has changed and the
        // other servers have not been told. Same shape as `channels/routes.ts`.
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

          // Every server hears it, including this one, which re-reads and arrives at what it
          // already has.
          await announceActionPolicyChange(transaction);
        });
      }
      settle(next, generated);
    },

    reset: async () => {
      // The saved policy is removed rather than overwritten with the configured one, so "reset" means
      // this deployment has no boundary of its own again, and changing what configuration says then
      // changes what it enforces, which is what an operator expects of a reset.
      if (database) {
        await database.transaction(async (transaction) => {
          await transaction
            .delete(actionPolicy)
            .where(eq(actionPolicy.id, CURRENT));
          await announceActionPolicyChange(transaction);
        });
      }
      /*
       * The template clauses stay. A reset says this deployment has no boundary of its OWN any more,
       * and a ceiling that came with an imported Bot is not the deployment's — it is the thing its
       * importer consented to, and it is taken off by retracting that import, in one act, with a row
       * saying who did it. A reset that quietly uncaged every imported Bot would be the most
       * surprising button in the product.
       */
      settle(clone(configured), generated);
    },

    load: async () => {
      if (!database) return "configuration";
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);
      /*
       * Read before either half is committed, so a failure leaves the process with the configured
       * policy and no clauses AND with a rejected promise, rather than serving with half of what it
       * should be enforcing. A deployment that cannot read its ceilings must not come up.
       */
      const clauses = await readGenerated();

      settle(
        row
          ? {
              mode: row.mode as ActionPolicy["mode"],
              deny: [...row.deny],
              allow: [...row.allow],
            }
          : clone(configured),
        clauses,
      );
      return row ? "the database" : "configuration";
    },

    refresh: async () => {
      if (!database) return;
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);
      const clauses = await readGenerated();

      // No row means somebody reset it, and reset means this deployment goes back to what
      // configuration says. Leaving the last saved rules in memory here would make a reset apply on
      // the server that served it and nowhere else, which is the bug this function exists to fix.
      //
      // Both reads finish before either is committed, so a refresh that fails halfway leaves this
      // server enforcing exactly what it was enforcing before. That is the right direction to fail
      // in for both halves: an added clause is missed until the next announcement, and a retracted
      // one keeps applying, which is over-strict rather than uncaged.
      settle(
        row
          ? {
              mode: row.mode as ActionPolicy["mode"],
              deny: [...row.deny],
              allow: [...row.allow],
            }
          : clone(configured),
        clauses,
      );
    },
  };
}

/**
 * The operator's rules and the imported ceilings, as one policy.
 *
 * Appended rather than merged, and appended AFTER, so a reader of a refusal sees the deployment's own
 * rules in the order an administrator wrote them and the generated clauses in a block at the end. In
 * a deny list order changes nothing about the verdict — any match denies — so this is entirely about
 * what the trail is like to read.
 */
function compose(
  stored: ActionPolicy,
  generated: readonly string[],
): ActionPolicy {
  return {
    mode: stored.mode,
    deny: [...stored.deny, ...generated],
    allow: [...stored.allow],
  };
}

/**
 * Tell every server the boundary moved.
 *
 * Never fatal. The rule is already saved and this process is already enforcing it, so a failed
 * announcement costs the other servers their update until their next restart, which is worth a loud
 * log and is not worth failing a write an administrator has been told succeeded.
 *
 * Exported because an administrator's save is no longer the only thing that moves the boundary: an
 * import writes a per-Bot ceiling and a retraction retires one, and neither goes anywhere near this
 * store. They call this on their own transaction, which is where the call belongs — a NOTIFY issued
 * inside the transaction is delivered on commit, so a rolled-back import announces nothing and there
 * is no window in which the rows have changed and the fleet has not been told. Every server hears
 * it, including the one that wrote it, and re-reads both halves.
 */
export async function announceActionPolicyChange(
  database: Pick<Database, "execute">,
): Promise<void> {
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
