/**
 * Which product this deployment is.
 *
 * `team` is OpenBot as an organization runs it. `personal` is one person on their own machine: no
 * sign-in, one shared computer, and none of the screens that govern other people. The governance
 * itself (the gateway, its policy, approvals and the audit trail) runs the same in both; the edition
 * only fixes what feeds it.
 */
export type Edition = "team" | "personal";

/** Unset or empty is `team`, so every deployment that predates the switch is unchanged. */
export function parseEdition(raw: string | undefined): Edition {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "team") return "team";
  if (value === "personal") return "personal";
  throw new Error(
    `OPENBOT_EDITION is "${value}". It must be "team" or "personal", or unset for "team".`,
  );
}
