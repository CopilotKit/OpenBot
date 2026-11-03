import { eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type CredentialExecutor,
  CredentialRefusedError,
  type CredentialStore,
} from "../credentials";
import type { Database } from "../db/client";
import { identityLinkChallenges } from "../db/schema";
import { idempotencyKey } from "../people/directory/client";
import { people } from "../people/directory/directory";
import type {
  IdentityWrite,
  LinkedIdentityRecord,
} from "../people/directory/types";
import { identityUserLock } from "./store";

/** Revokes a live credential; false when there is none or it was already revoked. */
async function revokeIfLive(
  credentials: Pick<CredentialStore, "revoke">,
  id: string | null,
  executor: CredentialExecutor,
): Promise<boolean> {
  if (!id) return false;
  try {
    await credentials.revoke(id, executor);
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
 * credential has that credential detached in the directory and revoked here, and a link without one
 * (Slack) changes status only. The links are NOT deleted, so the outside account keeps resolving to the
 * removed person and is refused, rather than turning into an unlinked guest. The person's pending link
 * codes are deleted first, under `identityUserLock` (the lock `issueChallenge` takes), so a code issued
 * before the removal cannot be redeemed into a fresh active link afterwards.
 *
 * All or nothing, as when the links were rows here. The links live in Intelligence's directory
 * (people/directory) now, and the vault and the trail here, so they cannot share one transaction:
 * every link is first retired in the directory, then the released credentials are revoked and every
 * `identity.link_retired` row is written in ONE transaction here (`auditFor` is handed it, so the trail's
 * own store writes into it). If any step fails, the links already retired in the directory are put back
 * as they were and the failure is rethrown, so a retry finds them all still to retire and audits every
 * one: a link is retired exactly when its row is written. No transaction is open while the directory is
 * called.
 *
 * One row per link that changed, shaped like `retireConnectionsFor`'s `mcp.account_disconnected`
 * rows: target the link id; payload `actor` (the remover, `by`), `owner` (the removed person),
 * `provider`, `reason` ("person_removed") and `credentialRevoked`, true only when this call revoked
 * a live credential (one already revoked is detached but not reported as revoked). The remover goes
 * in the payload and not in `actorUserId`, because `by` need not be a user id: a SCIM removal passes
 * "scim:directory". Never the subject, realm or credential id.
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
  await database.transaction(async (transaction) => {
    await identityUserLock(transaction, userId);
    await transaction
      .delete(identityLinkChallenges)
      .where(eq(identityLinkChallenges.userId, userId));
  });

  const client = people().client;
  const links = (await client.listIdentities({ userId }))
    .filter((link) => link.credentialId || link.status !== "needs_reconnect")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const retired: { before: LinkedIdentityRecord; after: IdentityWrite }[] = [];

  /** Put every link this call retired back as it was. Said, not thrown: the caller's failure is the news. */
  const putBack = async () => {
    for (const { before, after } of retired) {
      try {
        await client.updateIdentity(
          before.id,
          { status: before.status, credentialId: before.credentialId },
          idempotencyKey("retire-identity-undo"),
          after.identity.version,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "identity-retire-undo-failed",
            linkId: before.id,
            note: "This link was retired in the directory and its trail row was not written. Its credential, if any, is detached and still live.",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  try {
    for (const link of links) {
      const written = await client.updateIdentity(
        link.id,
        { credentialId: null, status: "needs_reconnect" },
        idempotencyKey("retire-identity"),
        link.version,
      );
      // Unlinked meanwhile: nothing left to retire.
      if (written) retired.push({ before: link, after: written });
    }
    await database.transaction(async (transaction) => {
      const executor = transaction as unknown as Database;
      const auditStore = auditFor(executor);
      for (const { before, after } of retired) {
        let credentialRevoked = false;
        for (const released of after.released)
          credentialRevoked =
            (await revokeIfLive(credentials, released, executor)) ||
            credentialRevoked;
        await recordAuditEvent(auditStore, {
          eventType: "identity.link_retired",
          targetType: "identity_link",
          targetId: before.id,
          payload: {
            actor: by,
            owner: userId,
            provider: before.provider,
            reason: "person_removed",
            credentialRevoked,
          },
        });
      }
    });
  } catch (error) {
    await putBack();
    throw error;
  }
  return retired.length;
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
