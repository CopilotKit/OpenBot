import { eq } from "drizzle-orm";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinks } from "../db/schema";

/**
 * Retires the credentials behind a removed person's identity links.
 *
 * The link rows stay: `user_id` deliberately has no foreign key, so the outside account keeps
 * resolving to the removed person and is refused, rather than turning into an unlinked guest. What
 * must not stay live is the token each link holds, so every one is revoked, detached from its link,
 * and the link marked `needs_reconnect`. One transaction, so a failure leaves nothing half-retired.
 *
 * Returns how many links had a credential retired; a second call returns 0.
 */
export async function retireIdentityLinks(
  database: Database,
  credentials: Pick<CredentialStore, "revoke">,
  userId: string,
): Promise<number> {
  return database.transaction(async (transaction) => {
    const links = await transaction
      .select({
        id: identityLinks.id,
        credentialId: identityLinks.credentialId,
      })
      .from(identityLinks)
      .where(eq(identityLinks.userId, userId))
      .for("update");
    let retired = 0;
    for (const link of links) {
      if (!link.credentialId) continue;
      try {
        await credentials.revoke(link.credentialId, transaction);
      } catch (error) {
        // Already revoked is the outcome we wanted.
        if (!(error instanceof CredentialRefusedError)) throw error;
      }
      await transaction
        .update(identityLinks)
        .set({
          credentialId: null,
          status: "needs_reconnect",
          updatedAt: new Date(),
        })
        .where(eq(identityLinks.id, link.id));
      retired += 1;
    }
    return retired;
  });
}
