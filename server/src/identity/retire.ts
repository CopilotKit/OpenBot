import { asc, eq, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinkChallenges, identityLinks } from "../db/schema";

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
 * One transaction, so a failure leaves nothing half-retired. One `identity.link_retired` audit row
 * per link that changed, written after the commit (the audit store has its own handle — the same
 * order `retireConnectionsFor` uses): actor `by`, target the link id, and the provider, the reason
 * and whether a credential was revoked. Never the subject, realm or credential id.
 *
 * Concurrency. The challenges are deleted first: a `redeemChallenge` in flight holds its challenge
 * row, so the delete waits for it to commit and the link it wrote is then seen below. Then, for
 * every realm the person has a link in, the exact advisory key `writeLink` takes for
 * `(userId, provider, realm)` is taken — in sorted order, before any row lock, the order `writeLink`
 * uses — so a concurrent re-link in a known realm finishes first or waits for this. The residual
 * window: a `writeLink` that is not a challenge redemption (an OAuth link) into a realm this person
 * had no link in, still uncommitted when the realms are read, commits an active link after this
 * returns. The person's sessions are already gone by then, so that needs a callback already past
 * its session check.
 *
 * Returns how many links changed; a second call returns 0 and writes no audit rows.
 */
export async function retireIdentityLinks(
  database: Database,
  credentials: Pick<CredentialStore, "revoke">,
  auditStore: AuditStore,
  userId: string,
  by: string,
): Promise<number> {
  const retired = await database.transaction(async (transaction) => {
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
    for (const { provider, realm } of realms) {
      // writeLink's key, character for character (server/src/identity/store.ts).
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}\u001f${provider}\u001f${realm}`}, 0))`,
      );
    }

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

    const changed: {
      id: string;
      provider: string;
      credentialRevoked: boolean;
    }[] = [];
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
      changed.push({
        id: link.id,
        provider: link.provider,
        credentialRevoked: Boolean(link.credentialId),
      });
    }
    return changed;
  });

  for (const link of retired) {
    await recordAuditEvent(auditStore, {
      eventType: "identity.link_retired",
      targetType: "identity_link",
      targetId: link.id,
      actorUserId: by,
      payload: {
        actor: by,
        provider: link.provider,
        reason: "person_removed",
        credentialRevoked: link.credentialRevoked,
      },
    });
  }
  return retired.length;
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
