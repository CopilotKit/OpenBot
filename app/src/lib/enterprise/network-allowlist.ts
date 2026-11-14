import { translateNetworkPolicy } from "@/lib/api/generated/network-policies/network-policies";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import type { EgressRule } from "./queries";

/** Whether every entry parses with the computer's own parser, and what is wrong with each that doesn't. */
export type EntriesCheck =
  | { ok: true }
  | { ok: false; error: string; problems: string[] };

/**
 * A network allowlist the deployment's model wrote from an admin's description.
 *
 * `reachable` and `explanation` are a second reading of `rules` by a call that never saw the
 * description, so they say what the list allows rather than what was asked for. Both are empty when
 * the list doesn't parse. `warning` is set for a list that opens every host under a top-level name,
 * every address, or nothing at all.
 */
export type NetworkAllowlistTranslation = {
  mode: "allowlist_only" | "defaults_plus_allowlist";
  rules: EgressRule[];
  summary: string | null;
  reachable: string[];
  explanation: string | null;
  check: EntriesCheck;
  warning: string | null;
};

/**
 * Description in, allowlist out. A plain function rather than a mutation: nothing is saved and
 * nothing is cached. The server records the request on the trail; saving the list is still the
 * admin's own act.
 */
export async function translateNetworkAllowlist(
  text: string,
): Promise<NetworkAllowlistTranslation> {
  const translation = await translateNetworkPolicy(
    ORGANIZATION_ID,
    { text },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't write the list. Try again, or type it yourself." },
  );
  // Entries that don't parse come back as the model wrote them, for the admin to fix; `check` says so.
  return translation as NetworkAllowlistTranslation;
}
