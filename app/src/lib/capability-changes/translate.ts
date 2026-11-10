import { client } from "@/lib/client";
import type { CapabilityKey } from "@/lib/enterprise/queries";

/** One switch to set: the organization's, a role's or a group's, for one permission. */
export type CapabilityChange = {
  scopeKind: "organization" | "role" | "group";
  /** Empty for the organization; "admin" or "user" for a role; the group's name for a group. */
  scopeId: string;
  capability: CapabilityKey;
  /** On, off, or null to remove the switch so the level beneath it decides. */
  allowed: boolean | null;
};

/** What is wrong with one change, counted from 1 as the screen counts them. */
export type CapabilityChangeProblem = {
  change: number;
  field: "scope" | "capability" | "allowed";
  message: string;
};

/**
 * Whether changes name real permissions, roles and groups and set nothing the rule ignores, such as
 * a group's off switch, and what is wrong with each when they don't.
 */
export type CapabilityChangesCheck =
  | { ok: true }
  | { ok: false; error: string; problems: CapabilityChangeProblem[] };

/**
 * Permission changes the deployment's model wrote from an admin's description.
 *
 * `explanation` is a second reading of `changes` by a call that never saw the description, so it says
 * what they do rather than what was asked for. Null when they don't check. `summary` is the same
 * reading in one sentence. `warning` is set when the changes leave a permission with nobody.
 */
export type CapabilityTranslation = {
  changes: CapabilityChange[];
  summary: string | null;
  explanation: string | null;
  check: CapabilityChangesCheck;
  warning: string | null;
};

/**
 * Description in, changes out. A plain function rather than a mutation: nothing is saved and nothing
 * is cached. The server records the request on the trail; saving the changes is still the admin's act.
 */
export async function translateCapabilityChanges(
  text: string,
): Promise<CapabilityTranslation> {
  const response = await client(
    "/api/admin/enterprise/capabilities/translate",
    {
      method: "POST",
      body: { text },
      fallback:
        "Couldn't write the changes. Try again, or set the switches by hand.",
    },
  );
  return (await response.json()) as CapabilityTranslation;
}
