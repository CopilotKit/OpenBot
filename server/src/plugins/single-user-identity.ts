import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { Database } from "../db/client";
import { brokeredConnections, brokeredIdentities } from "../db/schema";
import type { BrokerProvider } from "./access";

/**
 * Gives a single-user deployment its own name at its broker, Composio or Arcade, once, and stops
 * it acting under the shared one.
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
 * provider on the first start with that broker and never replaced, so it is the same on every
 * replica and after every restart. Only the name at the broker changes. The actor is still
 * `dev-local-user`, so Intelligence threads, memory and every local row stay attached to the same
 * person.
 *
 * EVERY SINGLE-USER DEPLOYMENT GETS ONE, INCLUDING ONE THAT ALREADY HOLDS CONNECTIONS. It used to
 * keep `dev-local-user` while any connection was recorded under it, and that kept exactly the
 * deployments that were sharing shared, for good: every connection made afterwards was filed under
 * the shared name too, and the records it trusted may not have been its own. Before this step a
 * deployment that opened an app another deployment on the key had connected recorded that account
 * as its own, by the confirm a page runs on load or by Connect adopting an account the broker
 * already held. Nothing at the broker says which deployment made an account under the shared name:
 * Composio's auth configs are found by a name suffix every deployment writes alike, and Arcade
 * files a connection under the user id and the provider and nothing else.
 *
 * SO A CONNECTION UNDER THE SHARED NAME IS RETIRED HERE, AND NEVER MOVED OR ENDED AT THE BROKER.
 * Neither broker can move one to another user id: Composio's connected-account update takes an
 * alias, credentials and a shared account's access list and no user id, and Arcade's user
 * connections can be listed and deleted and nothing else. Ending one at the broker would end it for
 * every other deployment on the key that still uses it, which may be its real owner. So this
 * deployment's `brokered_connections` rows for the broker whose person half is `dev-local-user`
 * under that same name are deleted here, in the transaction that writes the name, and nothing is
 * asked of the broker. Each such app then reads as not connected everywhere, a Bot's call on it is
 * answered with the card that offers Connect, and one Connect files the account under the new name.
 * Nothing here can act under `dev-local-user` again: no call, list, confirm, disconnect or
 * offboarding reaches it once no row names it. The accounts left at the broker under that name are
 * the broker's to remove, from its dashboard or API, where an operator can see whose they are.
 *
 * ON EVERY START, NOT ONLY THE FIRST. Nothing this version writes names `dev-local-user` at the
 * broker, so after the first start the delete finds nothing. It runs again anyway, because an older
 * version run against the same database files new connections under the shared name, and the start
 * after that has to retire them as the first one did.
 *
 * TWO REPLICAS STARTING TOGETHER AGREE. Each mints its own candidate, the primary key admits one,
 * and both read back the one that was kept.
 *
 * @param input.provider the broker this deployment has wired, or `null` where it has none
 * @returns the name the single-user person's accounts are filed under at the broker from now on, or
 *   `null` where there is no such person or no broker
 */
export async function ensureSingleUserIdentity(
  database: Pick<Database, "transaction">,
  input: { singleUser: boolean; provider: BrokerProvider | null },
  random: () => string = () => randomBytes(16).toString("base64url"),
): Promise<string | null> {
  const { provider } = input;
  if (!input.singleUser || !provider) return null;

  const { kept, retired } = await database.transaction(async (transaction) => {
    await transaction
      .insert(brokeredIdentities)
      .values({
        provider,
        userId: DEV_ACTOR.id,
        vendorUserId: `${DEV_ACTOR.id}:${random()}`,
      })
      .onConflictDoNothing();
    const retired = await transaction
      .delete(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.provider, provider),
          eq(brokeredConnections.holder, "person"),
          eq(brokeredConnections.userId, DEV_ACTOR.id),
          eq(brokeredConnections.vendorUserId, DEV_ACTOR.id),
        ),
      )
      .returning({ app: brokeredConnections.app });
    return {
      kept: await filedUnder(transaction, provider, DEV_ACTOR.id),
      retired: retired.map((row) => row.app),
    };
  });
  if (!kept) {
    throw new Error(
      "This deployment's identity at its connected-app broker was written and then could not be read back, so the server stopped rather than file accounts under a name it cannot find again.",
    );
  }
  if (retired.length > 0) {
    console.warn(
      JSON.stringify({
        type: "single-user-connections-retired",
        provider,
        apps: retired.sort(),
        note: "These apps were connected under dev-local-user, the name every single-user OpenBot shared at this broker, and this deployment now has its own. Their records here were removed and nothing was ended at the broker, because other deployments on the same key may be using those accounts. Each app reads as not connected until it is connected again.",
      }),
    );
  }
  return kept;
}

/**
 * The name `brokered_identities` holds for one person at one broker, or `null` where it holds none.
 *
 * THE ONE READ OF THAT TABLE. The startup above reads back what it wrote through it, and so does
 * every account resolution (`personAccountOf` in `plugin-store/context.ts`), so the name startup
 * settles and the name a call goes out under cannot be two readings of the table.
 */
export async function filedUnder(
  database: Pick<Database, "select">,
  provider: BrokerProvider,
  userId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ vendorUserId: brokeredIdentities.vendorUserId })
    .from(brokeredIdentities)
    .where(
      and(
        eq(brokeredIdentities.provider, provider),
        eq(brokeredIdentities.userId, userId),
      ),
    )
    .limit(1);
  return row?.vendorUserId ?? null;
}
