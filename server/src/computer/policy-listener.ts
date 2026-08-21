/**
 * Keep every server's copy of the boundary current.
 *
 * An administrator changes a rule on whichever server the load balancer picked. That server saves
 * the row and announces it; this is the other end, on every server including the one that wrote it.
 *
 * Without it the rule applied on one server out of N and nothing said so. The admin screen reported
 * success because the row really was saved, and the `computer.policy_loaded` audit row was written
 * at boot, so both the screen and the trail agreed with each other and disagreed with what the fleet
 * was enforcing. A deny rule that stops roughly one action in N is worse than no deny rule, because
 * it looks like it works.
 *
 * Its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool it would be a connection the rest of the server never gets back. Same shape, and the same
 * reason, as the channel activity listener.
 */
import postgres from "postgres";
import { ACTION_POLICY_TOPIC, type PolicyStore } from "./policy-store";

export type PolicyListener = { stop: () => Promise<void> };

export async function startPolicyListener(
  databaseUrl: string,
  store: PolicyStore,
): Promise<PolicyListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  /*
   * The payload is ignored on purpose. It says the boundary moved, not what it moved to: a rule list
   * can outgrow NOTIFY's 8000-byte cap, and a server enforcing whatever fitted in a payload would be
   * a subtler version of the bug this fixes. The row is the record; this re-reads it.
   */
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

  /*
   * Also on reconnect, which is the case a live notification cannot cover.
   *
   * A NOTIFY reaches whoever is listening at the time. A replica that was restarting, or whose
   * connection had dropped, is not, so it misses the announcement and goes on enforcing the rules it
   * read at boot until something restarts it again. That is the original bug wearing a smaller hat,
   * and it is worse for being intermittent.
   *
   * `onlisten` fires whenever the driver establishes or re-establishes the subscription, so the row
   * is re-read at exactly the moments this server could have missed something. Thanks to
   * @NathanTarbert, whose #94 caught this.
   */
  await connection.listen(ACTION_POLICY_TOPIC, reread, reread);

  return {
    stop: async () => {
      await connection.end();
    },
  };
}
