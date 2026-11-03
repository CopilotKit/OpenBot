import { asc, eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinkChallenges, identityLinks } from "../db/schema";
import { identityRealmLock, identityUserLock } from "./store";

/** Revokes a live credential; false when there is none or it was already revoked. */
async function revokeIfLive(
  credentials: Pick<CredentialStore, "revoke">,
  id: string | null,
): Promise<boolean> {
  if (!id) return false;
  try {
    await credentials.revoke(id);
    return true;
  } catch (error) {
    // Already revoked is the outcome wanted, but not this call's doing.
    if (error instanceof CredentialRefusedError) return false;
    throw error;
  }
}

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
 * every link already retired.
 *
 * One row per link that changed, shaped like `retireConnectionsFor`'s `mcp.account_disconnected`
 * rows: target the link id; payload `actor` (the remover, `by`), `owner` (the removed person),
 * `provider`, `reason` ("person_removed") and `credentialRevoked`, true only when this call revoked
 * a live credential (one already revoked is detached but not reported as revoked). The remover goes
 * in the payload and not in `actorUserId`, because `by` need not be a user id: a SCIM removal passes
 * "scim:directory". Never the subject, realm or credential id.
 *
 * Concurrency. Locks are taken in this order: `identityUserLock`, the lock `issueChallenge` takes, so
 * no code is issued alongside the removal; then the challenges are deleted, which waits for a
 * `redeemChallenge` in flight (it holds its challenge row) to commit, so the link it wrote is seen
 * below; then `identityRealmLock` for every `(provider, realm)` the person has a link in, in sorted
 * order (defensive: writeLink takes only the one key for the realm it writes, and two retirements of
 * one person already queue on the user lock); then the link rows. A writeLink into one of those realms
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
  /*
   * The tokens are revoked first, outside the transaction: the vault is Intelligence's, and no
   * transaction here may stay open across a call to it. A retirement that then fails leaves links
   * naming revoked tokens, which the retry detaches; it never leaves a detached token live.
   */
  const named = await database
    .select({ credentialId: identityLinks.credentialId })
    .from(identityLinks)
    .where(eq(identityLinks.userId, userId));
  const revokedHere = new Set<string>();
  for (const { credentialId } of named) {
    if (credentialId && (await revokeIfLive(credentials, credentialId)))
      revokedHere.add(credentialId);
  }

  const detached: string[] = [];
  const changed = await database.transaction(async (transaction) => {
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

    let count = 0;
    for (const link of links) {
      if (!link.credentialId && link.status === "needs_reconnect") continue;
      if (link.credentialId) detached.push(link.credentialId);
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
        payload: {
          actor: by,
          owner: userId,
          provider: link.provider,
          reason: "person_removed",
          credentialRevoked:
            link.credentialId !== null && revokedHere.has(link.credentialId),
        },
      });
      count += 1;
    }
    return count;
  });
  // A link written between the first read and the transaction named a token nothing revoked yet.
  for (const credentialId of detached)
    if (!revokedHere.has(credentialId))
      await revokeIfLive(credentials, credentialId);
  return changed;
}

/**
 * Everything a removed person had connected, retired in full whichever part fails.
 *
 * Every part always runs: the plugin half rethrows on purpose (a broker refusal), and stopping there
 * left every linked account's token live, with a retry hitting the same refusal first. The failure
 * is still thrown afterwards (the first one alone, or an AggregateError of them all whose message
 * names every cause, since callers log `String(error)`, which shows the message and not `.errors`), so
 * the caller's error handling sees it. On success, the count is the accounts retired; the person's
 * Recorder connections, which end with their sign-in (recorder/sign-out.ts), are not accounts and are
 * not counted.
 */
export async function retireOwnedAccounts(retirers: {
  plugins: () => Promise<{ retired: number }>;
  identities: () => Promise<number>;
  /** The person's browsers' Recorders, signed out with them. Absent where there is no Recorder. */
  recorders?: () => Promise<void>;
}): Promise<{ retired: number }> {
  const failures: Array<{ part: string; error: unknown }> = [];
  let retired = 0;
  try {
    retired += (await retirers.plugins()).retired;
  } catch (error) {
    failures.push({ part: "plugins", error });
  }
  try {
    retired += await retirers.identities();
  } catch (error) {
    failures.push({ part: "linked accounts", error });
  }
  if (retirers.recorders) {
    try {
      await retirers.recorders();
    } catch (error) {
      failures.push({ part: "Recorder connections", error });
    }
  }
  if (failures.length === 1) throw failures[0]?.error;
  if (failures.length > 1)
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Retiring a removed person's accounts failed in ${failures.length} parts: ${failures
        .map((failure) => `${failure.part}: ${messageOf(failure.error)}`)
        .join("; ")}`,
    );
  return { retired };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
