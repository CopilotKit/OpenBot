import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { Database } from "../db/client";
import { brokeredConnections, brokeredIdentities } from "../db/schema";
import type { BrokerProvider } from "./access";
import type { ConnectedAppBroker } from "./broker";

/**
 * Gives a single-user deployment its own name at its broker, Composio or Arcade, once.
 *
 * WHY IT NEEDS ONE. Both brokers file every grant under a user id the caller chooses, and this
 * deployment chooses the person's own id (see `personAccount`). A single-user deployment's one
 * person is `dev-local-user` on every such deployment, so every one of them using the same broker
 * key was the same user there. On Composio one deployment's Gmail was listed and used by another, a
 * disconnect in one ended the account for both, and a call that names no account ran in whichever
 * Gmail was connected last. On Arcade one deployment's consent to Google was the grant every other
 * deployment's calls ran on, and a disconnect in one withdrew it from all of them. Both vendors say
 * the same thing from the other side: Composio that a user id shared by more than one user exposes
 * each one's data to the others, Arcade that the id is the unique id of the user signed in.
 *
 * WHAT IT GIVES. `dev-local-user:<random>`, written to `brokered_identities` under the broker's own
 * provider and read back by the plugin store on every resolution, so it is the same on every replica
 * and after every restart. Only the name at the broker changes. The actor is still
 * `dev-local-user`, so Intelligence threads, memory and every local row stay attached to the same
 * person.
 *
 * AND WHEN IT GIVES NOTHING. A deployment that already holds grants under `dev-local-user` keeps that
 * name, so nobody is disconnected or asked to connect again. That is read off this deployment's own
 * `brokered_connections` for the broker's provider, never off the broker: asking it who holds grants
 * under `dev-local-user` would find every other single-user deployment's, which is the defect
 * itself. Composio writes that row when an account is connected or confirmed, and Arcade when its
 * verifier completes a consent or a confirm finds one; a deployment with no such row gets its own
 * name, and on Arcade that means its apps are approved once more under it. Nothing is written for a
 * deployment that keeps the shared name, so the question is asked again at the next start, and the
 * start after its last such grant is disconnected gives it its own. `composio_connections` is not
 * asked: it has not been written since migration 0052 copied its rows here, and a row left in it
 * says nothing about what is held now.
 *
 * ONE PATH FOR BOTH BROKERS, AND ONLY FOR ONE WHOSE GRANTS ARE RECORDED HERE. The question above can
 * only be answered from this deployment's own rows, so it is asked of the broker's DECLARED
 * {@link ConnectedAppBroker.grantIsLocal} rather than of its name, and both brokers declare it. A
 * broker that held its grants where no row here could see them would be left as it was, because a
 * new name could take away grants nobody can see. A signed-in deployment's people are filed under
 * their own ids, as before, and nothing is written for them.
 *
 * TWO REPLICAS STARTING TOGETHER AGREE. Each mints its own candidate, the primary key admits one,
 * and both read back the one that was kept.
 *
 * @param input.broker the broker this deployment has wired, or `null` where it has none
 * @returns the name the single-user person's accounts are filed under at the broker from now on, or
 *   `null` where there is no such person or no broker whose grants are recorded here
 */
export async function ensureSingleUserIdentity(
  database: Pick<Database, "select" | "insert">,
  input: {
    singleUser: boolean;
    broker:
      | (Pick<ConnectedAppBroker, "grantIsLocal"> & {
          provider: BrokerProvider;
        })
      | null;
  },
  random: () => string = () => randomBytes(16).toString("base64url"),
): Promise<string | null> {
  const { broker } = input;
  if (!input.singleUser || !broker?.grantIsLocal) return null;
  const { provider } = broker;

  const stored = await filedUnder(database, provider);
  if (stored) return stored;

  const [held] = await database
    .select({ app: brokeredConnections.app })
    .from(brokeredConnections)
    .where(
      and(
        eq(brokeredConnections.provider, provider),
        eq(brokeredConnections.holder, "person"),
        eq(brokeredConnections.userId, DEV_ACTOR.id),
        eq(brokeredConnections.vendorUserId, DEV_ACTOR.id),
      ),
    )
    .limit(1);
  if (held) return DEV_ACTOR.id;

  await database
    .insert(brokeredIdentities)
    .values({
      provider,
      userId: DEV_ACTOR.id,
      vendorUserId: `${DEV_ACTOR.id}:${random()}`,
    })
    .onConflictDoNothing();
  const kept = await filedUnder(database, provider);
  if (!kept) {
    throw new Error(
      "This deployment's identity at its connected-app broker was written and then could not be read back, so the server stopped rather than file accounts under a name it cannot find again.",
    );
  }
  return kept;
}

async function filedUnder(
  database: Pick<Database, "select">,
  provider: BrokerProvider,
): Promise<string | null> {
  const [row] = await database
    .select({ vendorUserId: brokeredIdentities.vendorUserId })
    .from(brokeredIdentities)
    .where(
      and(
        eq(brokeredIdentities.provider, provider),
        eq(brokeredIdentities.userId, DEV_ACTOR.id),
      ),
    )
    .limit(1);
  return row?.vendorUserId ?? null;
}
