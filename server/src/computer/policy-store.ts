/**
 * The policy the gateway is currently enforcing, and the ability to change it while running.
 *
 * It survives a restart. A rule held only in memory vanishes the next time the process comes up, and
 * the trail shows it being added without showing that it stopped applying. A reader would believe a
 * boundary held at a moment when it did not, and a form going through after a restart is
 * indistinguishable from a rule that never applied.
 *
 * Memory is the cache, and Intelligence is the record: the boundary is the organization policy's
 * action boundary (`policy/`). The gateway asks for the policy on every single action, so `get` stays
 * synchronous and reads from memory; the write goes through to Intelligence and the memory copy is
 * only updated once it has. A store that answered from Intelligence on every click would put a round
 * trip on the path of every keystroke a Bot makes.
 *
 * Memory is a cache of a shared record, not a per-process copy of it. OpenBot runs several servers
 * behind a load balancer, and an administrator's new rule arrives at exactly one of them. Kept only
 * in that process, the rule applies to roughly one action in N while the admin screen and the audit
 * row both report success, which is the boundary silently not applying: the failure this whole file
 * exists to prevent, in a different shape. So Intelligence announces every change and every server
 * re-reads (`policy-listener.ts`).
 *
 * Without the policy cache it still works in memory. Tests that only care about decision logic do not
 * need Intelligence.
 */
import type { PolicyCache } from "../policy/cache";
import type { ActionBoundaryRecord } from "../policy/types";
import type { ActionPolicy, RuleLabel } from "./policy";

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
  load: () => Promise<"intelligence" | "configuration">;
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
  /** Absent keeps everything in memory, which is what a test without Intelligence wants. */
  cache?: PolicyCache,
): PolicyStore {
  const configured = clone(initial);
  let current = clone(initial);

  /** What the held record says is in force: the saved boundary, or configuration's when none is. */
  const fromRecord = (record: ActionBoundaryRecord): ActionPolicy =>
    record.boundary
      ? {
          mode: record.boundary.mode,
          deny: [...record.boundary.deny],
          allow: [...record.boundary.allow],
          labels: { ...record.boundary.labels },
        }
      : clone(configured);

  return {
    get: () => current,

    set: async (policy, by) => {
      const next = clone(policy);
      if (cache) {
        // Written before it is enforced. If the write fails this throws and the caller reports a
        // failure, which is the honest outcome: an administrator who is told a rule was saved must
        // not be enforcing a rule that will disappear at the next restart. Intelligence announces it
        // to every server, including this one, which re-reads and arrives at what it already has.
        await cache.putActionBoundary(
          {
            mode: next.mode,
            deny: next.deny,
            allow: next.allow,
            labels: next.labels ?? {},
          },
          by ?? null,
        );
      }
      current = next;
    },

    reset: async () => {
      // The saved boundary is cleared rather than overwritten with the configured one, so "reset" means
      // this deployment has no boundary of its own again, and changing what configuration says then
      // changes what it enforces, which is what an operator expects of a reset.
      if (cache) await cache.resetActionBoundary();
      current = clone(configured);
    },

    load: async () => {
      if (!cache) return "configuration";
      const record = cache.actionBoundary();
      current = fromRecord(record);
      return record.boundary ? "intelligence" : "configuration";
    },

    refresh: async () => {
      if (!cache) return;
      // No boundary means somebody reset it, and reset means this deployment goes back to what
      // configuration says. Leaving the last saved rules in memory here would make a reset apply on
      // the server that served it and nowhere else, which is the bug this function exists to fix.
      current = fromRecord(cache.actionBoundary());
    },
  };
}

function clone(policy: ActionPolicy): ActionPolicy {
  return {
    mode: policy.mode,
    deny: [...policy.deny],
    allow: [...policy.allow],
    ...(policy.labels ? { labels: { ...policy.labels } } : {}),
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
