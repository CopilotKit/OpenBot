import { asc, eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinkChallenges, identityLinks } from "../db/schema";
import { identityRealmLock, identityUserLock } from "./store";

/**
 * Retires a removed person's identity links.
 *
 * Every one of the person's links is marked `needs_reconnect`, whatever its provider: a link with a
 * credential has that credential revoked and detached (`credential_id` null), and a link without one
 * (Slack) changes status only. The rows are NOT deleted — `user_id` deliberately has no foreign key,
 * so the outside account keeps resolving to the removed person and is refused, rather than turning
 * into an unlinked guest. The person's pending link challenges are deleted, so a code issued before
 * the removal cannot be redeemed into a fresh active link afterwards.
 *
 * One transaction, the audit rows included: `auditFor` is handed the transaction and returns the
 * store that writes into it (`createAuditStore(transaction)`, as approvals do), so a link is retired
 * exactly when its `identity.link_retired` row is written. A failure anywhere, an audit row
 * included, rolls the whole retirement back and a retry starts over and audits every link; writing
 * the rows after the commit instead lost the rest for good when one failed, because the retry found
 * every link already retired. One row per link that changed: actor `by`, target the link id, and the
 * provider, the reason and whether a credential was revoked. Never the subject, realm or credential
 * id.
 *
 * Concurrency. Locks are taken in this order: `identityUserLock`, the lock `issueChallenge` takes, so
 * no code is issued alongside the removal; then the challenges are deleted, which waits for a
 * `redeemChallenge` in flight (it holds its challenge row) to commit, so the link it wrote is seen
 * below; then `identityRealmLock` for every `(provider, realm)` the person has a link in, in sorted
 * order (writeLink takes the one key for the realm it writes, so sorting only keeps two retirements
 * of one person from deadlocking each other); then the link rows. A writeLink into one of those realms
 * that is already running finishes first and is retired here. One that arrives later waits, and once
 * this commits it goes ahead: it re-links that realm for the removed person, active again, so
 * refusing it is left to linkedUser's callers, which refuse a removed person. The same holds for a
 * writeLink (an OAuth link) into a realm the person had no link in when the realms were read. Both
 * need a callback already past its session check, since the person's sessions are gone by then.
 *
 * Returns how many links changed; a second call returns 0 and writes no audit rows.
 */
export async function retireIdentityLinks(
  database: Database,
  credentials: Pick<CredentialStore, "revoke">,
  auditFor: (executor: Database) => AuditStore,
  userId: string,
  by: string,
): Promise<number> {
  return database.transaction(async (transaction) => {
    const auditStore = auditFor(transaction as unknown as Database);
    await identityUserLock(transaction, userId);
    await transaction
      .delete(identityLinkChallenges)
      .where(eq(identityLinkChallenges.userId, userId));

    const realms = await transaction
      .selectDistinct({
        provider: identityLinks.provider,
        realm: identityLinks.realm,
      })
      .from(identityLinks)
      .where(eq(identityLinks.userId, userId))
      .orderBy(asc(identityLinks.provider), asc(identityLinks.realm));
    for (const { provider, realm } of realms)
      await identityRealmLock(transaction, userId, provider, realm);

    const links = await transaction
      .select({
        id: identityLinks.id,
        provider: identityLinks.provider,
        status: identityLinks.status,
        credentialId: identityLinks.credentialId,
      })
      .from(identityLinks)
      .where(eq(identityLinks.userId, userId))
      .orderBy(asc(identityLinks.id))
      .for("update");

    let changed = 0;
    for (const link of links) {
      if (!link.credentialId && link.status === "needs_reconnect") continue;
      if (link.credentialId) {
        try {
          await credentials.revoke(link.credentialId, transaction);
        } catch (error) {
          // Already revoked is the outcome we wanted.
          if (!(error instanceof CredentialRefusedError)) throw error;
        }
      }
      await transaction
        .update(identityLinks)
        .set({
          credentialId: null,
          status: "needs_reconnect",
          updatedAt: new Date(),
        })
        .where(eq(identityLinks.id, link.id));
      await recordAuditEvent(auditStore, {
        eventType: "identity.link_retired",
        targetType: "identity_link",
        targetId: link.id,
        actorUserId: by,
        payload: {
          actor: by,
          provider: link.provider,
          reason: "person_removed",
          credentialRevoked: Boolean(link.credentialId),
        },
      });
      changed += 1;
    }
    return changed;
  });
}

/**
 * Everything a removed person had connected, retired in full whichever half fails.
 *
 * Both halves always run: the plugin half rethrows on purpose (a broker refusal), and stopping there
 * left every linked account's token live, with a retry hitting the same refusal first. The failure
 * is still thrown afterwards — the first one alone, or an AggregateError of both — so the caller's
 * error handling sees it. On success, the count is both halves together.
 */
export async function retireOwnedAccounts(retirers: {
  plugins: () => Promise<{ retired: number }>;
  identities: () => Promise<number>;
}): Promise<{ retired: number }> {
  const failures: unknown[] = [];
  let retired = 0;
  try {
    retired += (await retirers.plugins()).retired;
  } catch (error) {
    failures.push(error);
  }
  try {
    retired += await retirers.identities();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Retiring a removed person's accounts failed in more than one place.",
    );
  return { retired };
}
