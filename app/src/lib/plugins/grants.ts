import { mutationOptions, queryOptions } from "@tanstack/react-query";
import {
  authorizeConnectionAction,
  authorizeSharedConnectionAction,
  getConnectionAuthorizations,
  getSharedConnectionAuthorizations,
} from "@/lib/api/generated/connections/connections";
import type { ActionAuthorizations } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { desktopShell } from "@/lib/desktop/shell";
import type { ConsentAction } from "./enablement-notes";

/**
 * What one account holds at one app, action by action, as getConnectionAuthorizations (a person's
 * own) or getSharedConnectionAuthorizations (an app's shared account) answers it.
 */
export type GrantState =
  | {
      action: string;
      state: "authorized";
      scopes: string[];
      /**
       * `held`: this account holds an authorization for it. `not-required`: the provider publishes
       * no authorization for it at all, so it is usable and no approval ever touches it. See
       * {@link coveredByApproval}, the one place this is turned into what an approval covers.
       */
      authorization: "held" | "not-required";
    }
  | { action: string; state: "needs-consent"; scopes: string[] }
  | { action: string; state: "needs-admin"; missing: string[] }
  | { action: string; state: "unknown"; reason: string };

export const grantKeys = {
  forServer: (serverId: string, shared = false) =>
    ["plugins", "grants", serverId, { shared }] as const,
};

/**
 * The account's actions in the shape the list draws. An answer the app couldn't give is the one
 * `unknown` entry named for the app, which {@link couldNotRead} recognises and never draws as an action.
 */
function grantsOf(
  serverId: string,
  answer: ActionAuthorizations,
): GrantState[] {
  if (!answer.readable)
    return [
      {
        action: serverId,
        state: "unknown",
        reason: answer.reason ?? "Couldn't read what this account allows.",
      },
    ];
  return answer.actions as GrantState[];
}

export function grantsQueryOptions(
  serverId: string,
  enabled: boolean,
  shared = false,
) {
  return queryOptions({
    queryKey: grantKeys.forServer(serverId, shared),
    enabled,
    queryFn: async (): Promise<GrantState[]> => {
      const fallback = "Couldn't read what this account allows.";
      const answer = shared
        ? await getSharedConnectionAuthorizations(organizationId(), serverId, {
            fallback,
          })
        : await getConnectionAuthorizations(organizationId(), "me", serverId, {
            fallback,
          });
      return grantsOf(serverId, answer);
    },
  });
}

/**
 * Begin authorizing ONE action. Answers the vendor's consent url, which the caller navigates to.
 *
 * `null` rather than `undefined` for the reason spelled out over `connectAccountMutationOptions`.
 */
export function authorizeActionMutationOptions(
  returnTo: "settings" | "admin" = "settings",
  shared = false,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      action: string;
    }): Promise<string | null> => {
      const body = {
        action: variables.action,
        returnTo: desktopShell()
          ? ("desktop" as const)
          : returnTo === "admin"
            ? ("apps" as const)
            : ("connections" as const),
      };
      const headers = { "Idempotency-Key": idempotencyKey() };
      const options = { fallback: "Couldn't authorize that action." };
      const started = shared
        ? await authorizeSharedConnectionAction(
            organizationId(),
            variables.serverId,
            body,
            headers,
            options,
          )
        : await authorizeConnectionAction(
            organizationId(),
            "me",
            variables.serverId,
            body,
            headers,
            options,
          );
      return started.authorizationUrl ?? null;
    },
  });
}

/**
 * Whether this answer is the route's synthetic "could not read".
 *
 * WHEN `grantsFor` THROWS, THE ROUTE ANSWERS 200 WITH ONE `unknown` ENTRY WHOSE `action` IS THE
 * TOOLKIT NAME: a throw yields no action names to enumerate, so that label is not an action and must
 * never be drawn as one. Recognised as a sole `unknown` entry that is either the app's own name or
 * not shaped like an action at all (an Arcade action is dotted, `Toolkit.Action`; a toolkit is not).
 */
export function couldNotRead(
  grants: readonly GrantState[],
  appNames: readonly string[],
): boolean {
  if (grants.length !== 1) return false;
  const [only] = grants;
  if (only?.state !== "unknown") return false;
  const label = only.action.toLowerCase();
  return (
    appNames.some((name) => name.toLowerCase() === label) ||
    !only.action.includes(".")
  );
}

/**
 * Whether approving at this app is what makes `grant` usable — THE ONE DEFINITION OF THE SET THE
 * CONSENT COPY COUNTS.
 *
 * WHAT A PERSON CONSENTS TO IS THE AUTHORIZATION, so an action belongs here exactly when that
 * authorization is what stands between it and being called: one somebody still has to approve
 * (`needs-consent`), or one already approved and held (`authorized`, `held`). The "N" in "approving
 * this approves all N" is the size of this set and of nothing else.
 *
 * AN ACTION THAT NEEDS NO AUTHORIZATION IS NOT IN IT. It is usable before anybody approves anything
 * and stays usable if they refuse, so telling a person that approving "approves" it inflates what
 * they are being asked to agree to by actions nothing ever withheld. That inflation is not
 * hypothetical: when the server began reading an absent authorization block as `authorized` rather
 * than `unknown`, every such action silently joined this count. So the decision is made HERE, on the
 * field that says why an action is authorized, and never on `state` alone.
 *
 * `needs-admin` and `unknown` are not in it either: whether an approval would reach them cannot
 * be read off the answer, so they are left out of the number rather than guessed into it.
 */
export function coveredByApproval(
  grant: GrantState,
): grant is Extract<GrantState, { state: "authorized" | "needs-consent" }> {
  if (grant.state === "needs-consent") return true;
  return grant.state === "authorized" && grant.authorization === "held";
}

/** The actions the consent copy reasons about: exactly those {@link coveredByApproval} admits. */
export function consentActionsFrom(
  grants: readonly GrantState[],
): ConsentAction[] {
  const actions: ConsentAction[] = [];
  for (const grant of grants) {
    if (coveredByApproval(grant)) {
      actions.push({ name: grant.action, scopes: grant.scopes });
    }
  }
  return actions;
}

export type GrantGroup = {
  /** The permissions every action in the group requires; empty for the whole-app and no-permission groups. */
  scopes: string[];
  /**
   * "whole-app" when no action in the app names a permission, holding every action one approval
   * covers; "none" for actions that name none — always including those that need no authorization.
   */
  kind: "scoped" | "whole-app" | "none";
  grants: GrantState[];
};

function isNotRequired(grant: GrantState): boolean {
  return grant.state === "authorized" && grant.authorization === "not-required";
}

function scopesOf(grant: GrantState): string[] {
  return grant.state === "authorized" || grant.state === "needs-consent"
    ? [...new Set(grant.scopes)].sort()
    : [];
}

/** The one state ordering: `groupGrants` sorts by it and `GrantList` picks its unauthorized tail by it. */
export const RANK: Record<GrantState["state"], number> = {
  authorized: 0,
  "needs-consent": 1,
  "needs-admin": 2,
  unknown: 3,
};

/**
 * The grant list grouped by the permission each action requires, so what is drawn after a consent
 * matches what the consent screen said.
 *
 * AN ALL-OR-NOTHING APP IS ONE GROUP CONTAINING EVERYTHING: when no action names a permission there
 * is nothing to group on, and one group is the honest rendering rather than a degraded one. Names
 * are compared exactly and never case-folded: Arcade's are case-sensitive.
 */
export function groupGrants(grants: readonly GrantState[]): GrantGroup[] {
  const anyScoped = grants.some((grant) => scopesOf(grant).length > 0);
  const ordered = [...grants].sort(
    (left, right) =>
      RANK[left.state] - RANK[right.state] ||
      left.action.localeCompare(right.action),
  );
  if (!anyScoped) {
    // "Everything in this app, approved together" is a claim about what one approval covers, so an
    // action that needs no authorization is drawn outside it — the same set the consent copy's
    // count leaves out (see {@link coveredByApproval}), so the heading and the number agree.
    const needsNone = ordered.filter(isNotRequired);
    const together = ordered.filter((grant) => !isNotRequired(grant));
    const groups: GrantGroup[] = [];
    if (together.length > 0) {
      groups.push({ scopes: [], kind: "whole-app", grants: together });
    }
    if (needsNone.length > 0) {
      groups.push({ scopes: [], kind: "none", grants: needsNone });
    }
    return groups;
  }
  const groups = new Map<string, GrantGroup>();
  for (const grant of ordered) {
    const scopes = scopesOf(grant);
    const key = scopes.join("\u0000");
    let group = groups.get(key);
    if (!group) {
      group = {
        scopes,
        kind: scopes.length > 0 ? "scoped" : "none",
        grants: [],
      };
      groups.set(key, group);
    }
    group.grants.push(grant);
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(left.kind === "none") - Number(right.kind === "none") ||
      left.scopes.join(",").localeCompare(right.scopes.join(",")),
  );
}
