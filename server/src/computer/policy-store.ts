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
import type { ActionPolicy, RuleLabel } from "./policy";

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
              labels: next.labels ?? {},
              updatedBy: by ?? null,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: actionPolicy.id,
              set: {
                mode: next.mode,
                deny: next.deny,
                allow: next.allow,
                labels: next.labels ?? {},
                updatedBy: by ?? null,
                updatedAt: new Date(),
              },
            });

          // Every server hears it, including this one, which re-reads and arrives at what it
          // already has.
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
      if (!row) return "configuration";

      current = fromRow(row);
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
      current = row ? fromRow(row) : clone(configured);
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
async function announce(database: Pick<Database, "execute">): Promise<void> {
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
    ...(policy.labels ? { labels: { ...policy.labels } } : {}),
  };
}

function fromRow(row: typeof actionPolicy.$inferSelect): ActionPolicy {
  return {
    mode: row.mode as ActionPolicy["mode"],
    deny: [...row.deny],
    allow: [...row.allow],
    labels: { ...row.labels },
  };
}

const MAX_LABEL_NAME = 80;
const MAX_LABEL_DESCRIPTION = 300;

/**
 * Each rule's name and description, kept only for rules the policy still has.
 *
 * A label for a rule that is not in either list is dropped rather than refused: it is what removing a
 * rule from a policy read moments ago leaves behind, and it can never be shown against anything.
 */
function parseLabels(
  input: unknown,
  rules: string[],
):
  | { ok: true; labels: Record<string, RuleLabel> }
  | { ok: false; error: string } {
  if (input === undefined) return { ok: true, labels: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "labels must map each rule to a name." };
  }
  const known = new Set(rules);
  const labels: Record<string, RuleLabel> = {};
  for (const [rule, value] of Object.entries(input)) {
    const label = value as Partial<RuleLabel> | null;
    const name = typeof label?.name === "string" ? label.name.trim() : "";
    const description =
      label?.description === undefined
        ? ""
        : typeof label.description === "string"
          ? label.description.trim()
          : null;
    if (!name || name.length > MAX_LABEL_NAME) {
      return {
        ok: false,
        error: `Each rule needs a name of at most ${MAX_LABEL_NAME} characters.`,
      };
    }
    if (description === null || description.length > MAX_LABEL_DESCRIPTION) {
      return {
        ok: false,
        error: `A rule's description must be at most ${MAX_LABEL_DESCRIPTION} characters.`,
      };
    }
    if (known.has(rule)) labels[rule] = { name, description };
  }
  return { ok: true, labels };
}

/**
 * Where a saved rule came from, when it was not typed as CEL: a sentence in plain English that a model
 * turned into the rule the admin then approved. Recorded with the save, so the trail can answer what
 * the admin asked for as well as what was enforced.
 */
export type PolicyAuthoring = { source: "english"; text: string };

const MAX_AUTHORING_TEXT = 2_000;

/** The optional `authoring` a save carries, refused rather than dropped when it is malformed. */
export function parsePolicyAuthoring(
  input: unknown,
): { ok: true; authoring?: PolicyAuthoring } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true };
  const candidate = input as { source?: unknown; text?: unknown };
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (
    typeof input !== "object" ||
    candidate.source !== "english" ||
    !text ||
    text.length > MAX_AUTHORING_TEXT
  ) {
    return {
      ok: false,
      error: `authoring must be { source: "english", text } with text of at most ${MAX_AUTHORING_TEXT} characters.`,
    };
  }
  return { ok: true, authoring: { source: "english", text } };
}

type RuleChange = { list: "deny" | "allow"; rule: string; name?: string };

/** The rules in `from` that `to` does not have, list by list, each with its name where it has one. */
function rulesOnlyIn(from: ActionPolicy, to: ActionPolicy): RuleChange[] {
  return (["deny", "allow"] as const).flatMap((list) =>
    from[list]
      .filter((rule) => !to[list].includes(rule))
      .map((rule) => {
        const name = from.labels?.[rule]?.name;
        return { list, rule, ...(name ? { name } : {}) };
      }),
  );
}

/**
 * What a save changed, as `computer.policy_changed` records it: who, the rules added and removed, the
 * mode either side, and the whole policy before and after, so the trail alone can say what the
 * boundary was at any moment. A rule has no identity apart from its text, so an edited rule is the
 * old text removed and the new text added.
 */
export function policyChange(
  before: ActionPolicy,
  after: ActionPolicy,
  by: string,
  authoring?: PolicyAuthoring,
): Record<string, unknown> {
  return {
    by,
    added: rulesOnlyIn(after, before),
    removed: rulesOnlyIn(before, after),
    mode: { before: before.mode, after: after.mode },
    before: clone(before),
    after: clone(after),
    ...(authoring ? { authoring } : {}),
  };
}

/**
 * Validate a policy that arrived over HTTP.
 *
 * Rejects rather than coerces. A policy is the thing standing between a Bot and somebody's live
 * website, and "we accepted your rule but not in the shape you wrote it" is the one behaviour that
 * must never happen here: an operator would believe a restriction is in force when it is not.
 *
 * Only the shape is checked here. Whether each rule can be evaluated is `checkPolicyRule`'s question
 * (`./policy.ts`), asked by the routes that save and replay a policy, with cel-js's own parser, so
 * there is one parser and nothing to keep in agreement with it.
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

  const labels = parseLabels(candidate.labels, [...lists.deny, ...lists.allow]);
  if (!labels.ok) return labels;

  return {
    ok: true,
    policy: {
      mode,
      deny: lists.deny,
      allow: lists.allow,
      labels: labels.labels,
    },
  };
}
