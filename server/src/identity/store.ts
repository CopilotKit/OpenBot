import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinks } from "../db/schema";
import { acceptsMethod, parseIdentity } from "./providers";
import {
  type Identity,
  IdentityConflictError,
  IdentityInputError,
  type IdentityLink,
  type IdentityProvider,
  type LinkMethod,
  type LinkStatus,
} from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Revoke = Pick<CredentialStore, "revoke">;

const identityMatches = (identity: Identity) =>
  and(
    eq(identityLinks.provider, identity.provider),
    eq(identityLinks.realm, identity.realm),
    eq(identityLinks.subject, identity.subject),
  );

function toLink(row: typeof identityLinks.$inferSelect): IdentityLink {
  return {
    id: row.id,
    provider: row.provider as IdentityProvider,
    realm: row.realm,
    subject: row.subject,
    userId: row.userId,
    handle: row.handle,
    verifiedBy: row.verifiedBy,
    credentialId: row.credentialId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Postgres unique_violation. Bun's driver puts the SQLSTATE in `errno`; drizzle wraps it as `cause`. */
function isUniqueViolation(error: unknown) {
  const sqlState = (value: unknown) =>
    (value as { errno?: unknown } | null | undefined)?.errno;
  return (
    sqlState(error) === "23505" ||
    sqlState((error as { cause?: unknown } | null | undefined)?.cause) ===
      "23505"
  );
}

async function revokeQuietly(
  credentials: Revoke,
  id: string | null,
  executor: Transaction,
) {
  if (!id) return;
  try {
    await credentials.revoke(id, executor);
  } catch (error) {
    // Already revoked is the outcome we wanted.
    if (!(error instanceof CredentialRefusedError)) throw error;
  }
}

/**
 * Link `identity` to `userId` inside `transaction`.
 *
 * The identity row is locked first. Linked to somebody else: refused. Linked to this person: updated
 * in place. Otherwise this person's older link in the same realm, if any, is removed with its
 * credential, and the new link inserted. A racing insert of the same identity surfaces as a unique
 * violation, which is the same refusal.
 */
export async function writeLink(
  transaction: Transaction,
  credentials: Revoke,
  identity: Identity,
  userId: string,
  proof: {
    method: LinkMethod;
    handle?: string | null;
    credentialId?: string | null;
  },
): Promise<IdentityLink> {
  const [existing] = await transaction
    .select()
    .from(identityLinks)
    .where(identityMatches(identity))
    .for("update");
  if (existing && existing.userId !== userId) throw new IdentityConflictError();
  const now = new Date();
  if (existing) {
    if (existing.credentialId && existing.credentialId !== proof.credentialId)
      await revokeQuietly(credentials, existing.credentialId, transaction);
    const [updated] = await transaction
      .update(identityLinks)
      .set({
        handle: proof.handle ?? existing.handle,
        verifiedBy: proof.method,
        credentialId: proof.credentialId ?? null,
        status: "active",
        updatedAt: now,
      })
      .where(eq(identityLinks.id, existing.id))
      .returning();
    return toLink(updated as typeof identityLinks.$inferSelect);
  }
  const [previous] = await transaction
    .select()
    .from(identityLinks)
    .where(
      and(
        eq(identityLinks.userId, userId),
        eq(identityLinks.provider, identity.provider),
        eq(identityLinks.realm, identity.realm),
      ),
    )
    .for("update");
  if (previous) {
    await transaction
      .delete(identityLinks)
      .where(eq(identityLinks.id, previous.id));
    await revokeQuietly(credentials, previous.credentialId, transaction);
  }
  try {
    const [inserted] = await transaction
      .insert(identityLinks)
      .values({
        id: randomUUID(),
        provider: identity.provider,
        realm: identity.realm,
        subject: identity.subject,
        userId,
        handle: proof.handle ?? null,
        verifiedBy: proof.method,
        credentialId: proof.credentialId ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toLink(inserted as typeof identityLinks.$inferSelect);
  } catch (error) {
    if (isUniqueViolation(error)) throw new IdentityConflictError();
    throw error;
  }
}

export function createIdentityStore(database: Database, credentials: Revoke) {
  return {
    async linkedUser(
      value: Identity,
    ): Promise<{ userId: string; status: LinkStatus } | null> {
      const identity = parseIdentity(value);
      const [link] = await database
        .select({ userId: identityLinks.userId, status: identityLinks.status })
        .from(identityLinks)
        .where(identityMatches(identity));
      return link ?? null;
    },

    async identitiesFor(
      userId: string,
      provider?: IdentityProvider,
    ): Promise<IdentityLink[]> {
      const rows = await database
        .select()
        .from(identityLinks)
        .where(
          provider
            ? and(
                eq(identityLinks.userId, userId),
                eq(identityLinks.provider, provider),
              )
            : eq(identityLinks.userId, userId),
        )
        .orderBy(identityLinks.provider, identityLinks.createdAt);
      return rows.map(toLink);
    },

    async linkVerified(
      value: Identity,
      userId: string,
      proof: {
        method: LinkMethod;
        handle?: string | null;
        credentialId?: string | null;
      },
    ): Promise<IdentityLink> {
      const identity = parseIdentity(value);
      if (!userId.trim()) throw new IdentityInputError();
      if (!acceptsMethod(identity.provider, proof.method))
        throw new IdentityInputError(
          "This provider does not accept that kind of proof.",
        );
      return database.transaction((transaction) =>
        writeLink(transaction, credentials, identity, userId, proof),
      );
    },

    async markNeedsReconnect(linkId: string): Promise<void> {
      await database
        .update(identityLinks)
        .set({ status: "needs_reconnect", updatedAt: new Date() })
        .where(eq(identityLinks.id, linkId));
    },

    async unlink(userId: string, linkId: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const [removed] = await transaction
          .delete(identityLinks)
          .where(
            and(eq(identityLinks.id, linkId), eq(identityLinks.userId, userId)),
          )
          .returning({ credentialId: identityLinks.credentialId });
        if (!removed) return false;
        await revokeQuietly(credentials, removed.credentialId, transaction);
        return true;
      });
    },
  };
}

export type IdentityStore = ReturnType<typeof createIdentityStore>;
