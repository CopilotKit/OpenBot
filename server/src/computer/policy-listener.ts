/**
 * Keep every server's copy of the boundary current.
 *
 * An administrator changes a rule on whichever server the load balancer picked. That server saves
 * it in Intelligence, and Intelligence announces it; the policy cache on every server, including the
 * one that wrote it, reads the new boundary and tells this, which re-reads it into the store the
 * gateway asks on every action.
 *
 * Without it the rule applied on one server out of N and nothing said so. The admin screen reported
 * success because the boundary really was saved, and the `computer.policy_loaded` audit row was
 * written at boot, so both the screen and the trail agreed with each other and disagreed with what
 * the fleet was enforcing. A deny rule that stops roughly one action in N is worse than no deny rule,
 * because it looks like it works.
 *
 * A missed announcement is the case a live notification cannot cover: a replica that was restarting,
 * or whose socket had dropped, would go on enforcing the rules it read at boot. The cache reads
 * everything again whenever its subscription joins, which includes every reconnect, and every minute,
 * and each of those reads reaches here as a change when the boundary moved. Thanks to
 * @NathanTarbert, whose #94 caught the reconnect case.
 */
import type { PolicyCache } from "../policy/cache";
import type { PolicyStore } from "./policy-store";

export type PolicyListener = { stop: () => Promise<void> };

export async function startPolicyListener(
  cache: PolicyCache,
  store: PolicyStore,
): Promise<PolicyListener> {
  const reread = () => {
    void store.refresh().catch((error) => {
      console.error(
        JSON.stringify({
          type: "action-policy-refresh-failed",
          note: "This server was told the boundary changed and could not re-read it, so it is still enforcing the previous rules.",
          error: String(error),
        }),
      );
    });
  };
  const stopListening = cache.onChange((resource) => {
    if (resource === "action_boundary") reread();
  });
  // What the cache holds now, in case it changed between the store's load and this subscription.
  reread();

  return {
    stop: async () => {
      stopListening();
    },
  };
}
