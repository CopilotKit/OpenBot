import { randomBytes } from "node:crypto";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { BrokerProvider } from "./access";
import {
  ensureIdentity,
  findIdentity,
  removeBrokered,
} from "./plugin-store/records";

export async function ensureSingleUserIdentity(
  input: { singleUser: boolean; provider: BrokerProvider | null },
  random: () => string = () => randomBytes(16).toString("base64url"),
): Promise<string | null> {
  const { provider } = input;
  if (!input.singleUser || !provider) return null;

  /*
   * Both in Intelligence now. The name is filed first, and only if there is none (two replicas
   * booting together file the same record under the same id, and the second keeps the first's); then
   * the accounts filed under the old shared name are cleared. Read back from Intelligence, so every
   * replica answers with the one name it holds.
   */
  await ensureIdentity({
    provider,
    userId: DEV_ACTOR.id,
    vendorUserId: `${DEV_ACTOR.id}:${random()}`,
  });
  const retired: string[] = [];
  await removeBrokered((row) => {
    const matched =
      row.provider === provider &&
      row.holder === "person" &&
      row.userId === DEV_ACTOR.id &&
      row.vendorUserId === DEV_ACTOR.id;
    if (matched) retired.push(row.app);
    return matched;
  });
  const kept = await filedUnder(provider, DEV_ACTOR.id);
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
  provider: BrokerProvider,
  userId: string,
): Promise<string | null> {
  return (await findIdentity(provider, userId))?.vendorUserId ?? null;
}
