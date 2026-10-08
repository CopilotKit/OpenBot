import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, notInArray, sql } from "drizzle-orm";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import {
  credentials as credentialRows,
  identityLinkChallenges,
  identityLinks,
} from "../db/schema";
import { acceptsMethod, isIdentityProvider, parseIdentity } from "./providers";
import {
  type Identity,
  IdentityConflictError,
  IdentityInputError,
  type IdentityLink,
  IdentityLinkError,
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

/** `provider` is the row's provider, already checked against the registry by the caller. */
function toLink(
  row: typeof identityLinks.$inferSelect,
  provider: IdentityProvider,
): IdentityLink {
  return {
    id: row.id,
    provider,
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

/**
 * The violated constraint's name when `error` is a Postgres unique_violation (SQLSTATE 23505), else
 * null. Bun's driver puts the SQLSTATE in `errno` and the name in `constraint`; drizzle wraps the
 * driver error as `cause`.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  type Driver = { errno?: unknown; constraint?: unknown };
  const candidates = [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ];
  for (const candidate of candidates) {
    if (candidate?.errno === "23505")
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : "";
  }
  return null;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CREDENTIAL_UNAVAILABLE = "The credential for this link is not available.";

/**
 * Claim `credentialId` for the link being written, inside its transaction: the credential row is
 * locked live (`for update`, so a concurrent revoke waits for this link to commit or sees it), and
 * it must not already belong to a link other than `own` (the identity's own link and the person's
 * older link in the realm, which this write replaces). The partial unique index
 * identity_links_credential_idx is the backstop.
 */
async function claimCredential(
  transaction: Transaction,
  credentialId: string,
  own: string[],
) {
  const [live] = await transaction
    .select({ id: credentialRows.id })
    .from(credentialRows)
    .where(
      and(
        eq(credentialRows.id, credentialId),
        isNull(credentialRows.revokedAt),
      ),
    )
    .for("update");
  if (!live) throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
  const [taken] = await transaction
    .select({ id: identityLinks.id })
    .from(identityLinks)
    .where(
      own.length
        ? and(
            eq(identityLinks.credentialId, credentialId),
            notInArray(identityLinks.id, own),
          )
        : eq(identityLinks.credentialId, credentialId),
    )
    .limit(1);
  if (taken) throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
}

/**
 * Link `identity` to `userId` inside `transaction`. Module-private: only `linkVerified` (which
 * validates the proof first) and `redeemChallenge` (no credential) call it.
 *
 * Two races are handled. Two people racing for one identity: the identity row is locked first, and a
 * racing insert surfaces as a unique violation on the identity index, which is a refusal
 * (IdentityConflictError). One person racing two identities in one realm: serialized by a
 * per-person-per-realm advisory lock taken before any row lock, so the later link sees the earlier
 * one as `previous` and replaces it.
 *
 * Locks are taken advisory lock, then link rows, then the credential row: the order
 * retireIdentityLinks uses, so the two cannot deadlock.
 *
 * Under the lock: linked to somebody else: refused. Linked to this person: re-verified. Otherwise
 * this person's older link in the same realm, if any, is removed and the new link inserted.
 *
 * Credential and handle: `undefined` keeps what the link has; a new credential replaces the old
 * one, which is revoked; there is no clearing a credential here (unlink does that). An explicit
 * null handle clears it. A replaced older link's credential is revoked unless the new link is
 * taking that same credential.
 */
async function writeLink(
  transaction: Transaction,
  credentials: Revoke,
  identity: Identity,
  userId: string,
  proof: {
    method: LinkMethod;
    handle?: string | null;
    credentialId?: string;
  },
): Promise<IdentityLink> {
  try {
    return await writeLinkLocked(
      transaction,
      credentials,
      identity,
      userId,
      proof,
    );
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === "identity_links_identity_idx")
      throw new IdentityConflictError();
    if (constraint === "identity_links_credential_idx")
      throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
    throw error;
  }
}

async function writeLinkLocked(
  transaction: Transaction,
  credentials: Revoke,
  identity: Identity,
  userId: string,
  proof: {
    method: LinkMethod;
    handle?: string | null;
    credentialId?: string;
  },
): Promise<IdentityLink> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}\u001f${identity.provider}\u001f${identity.realm}`}, 0))`,
  );
  const [existing] = await transaction
    .select()
    .from(identityLinks)
    .where(identityMatches(identity))
    .for("update");
  if (existing && existing.userId !== userId) throw new IdentityConflictError();
  const now = new Date();
  if (existing) {
    if (proof.credentialId)
      await claimCredential(transaction, proof.credentialId, [existing.id]);
    const credentialId = proof.credentialId ?? existing.credentialId;
    if (existing.credentialId && existing.credentialId !== credentialId)
      await revokeQuietly(credentials, existing.credentialId, transaction);
    const [updated] = await transaction
      .update(identityLinks)
      .set({
        handle: proof.handle === undefined ? existing.handle : proof.handle,
        verifiedBy: proof.method,
        credentialId,
        status: "active",
        updatedAt: now,
      })
      .where(eq(identityLinks.id, existing.id))
      .returning();
    return toLink(
      updated as typeof identityLinks.$inferSelect,
      identity.provider,
    );
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
  if (proof.credentialId)
    await claimCredential(
      transaction,
      proof.credentialId,
      previous ? [previous.id] : [],
    );
  if (previous) {
    await transaction
      .delete(identityLinks)
      .where(eq(identityLinks.id, previous.id));
    // The new link may be taking this very credential: then it is moved, not revoked.
    if (previous.credentialId !== proof.credentialId)
      await revokeQuietly(credentials, previous.credentialId, transaction);
  }
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
  return toLink(
    inserted as typeof identityLinks.$inferSelect,
    identity.provider,
  );
}

/** Refuses anything that is not a code OpenBot could have issued before it reaches a query. */
function codeHash(code: string) {
  if (typeof code !== "string" || !UUID.test(code))
    throw new IdentityLinkError();
  return createHash("sha256").update(code.toLowerCase()).digest("hex");
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
      // `provider` is free text, so a row written by a removed or future integration can carry one
      // this build does not know. Skip it rather than hand callers a provider they cannot render.
      const links: IdentityLink[] = [];
      for (const row of rows) {
        if (isIdentityProvider(row.provider))
          links.push(toLink(row, row.provider));
        else
          console.warn(
            JSON.stringify({
              type: "identity-link-unknown-provider",
              linkId: row.id,
            }),
          );
      }
      return links;
    },

    /**
     * Link `value` to `userId` on proof the caller has already verified.
     *
     * A `credentialId`, when given, must be a UUID naming a live credential that no other link
     * holds: it is checked and locked in the link's own transaction, so a malformed, missing,
     * revoked or already-owned id is refused rather than stored as a token the link does not
     * have. Omitting it keeps the credential an existing link already has (a re-sign-in that mints
     * no token must not kill the working one); a different id replaces it and revokes the old one.
     * Only unlink clears a credential. `handle` likewise: omitted keeps, null clears.
     *
     * A "challenge" link proves control by code and carries no credential, so it refuses one. An
     * "oauth" link is not required to carry one: GitHub sign-in may link before a token is stored.
     */
    async linkVerified(
      value: Identity,
      userId: string,
      proof: {
        method: LinkMethod;
        handle?: string | null;
        credentialId?: string;
      },
    ): Promise<IdentityLink> {
      const identity = parseIdentity(value);
      if (!userId.trim()) throw new IdentityInputError();
      if (!acceptsMethod(identity.provider, proof.method))
        throw new IdentityInputError(
          "This provider does not accept that kind of proof.",
        );
      if (proof.credentialId != null && proof.method === "challenge")
        throw new IdentityInputError(
          "A challenge link does not carry a credential.",
        );
      // Shape first, so a malformed id never reaches Postgres (and its error never echoes it).
      if (
        proof.credentialId != null &&
        (typeof proof.credentialId !== "string" ||
          !UUID.test(proof.credentialId))
      )
        throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
      // Lowercase: uuid columns read back lowercase, and keep/move compare ids as strings.
      const credentialId = proof.credentialId?.toLowerCase() ?? undefined;
      return database.transaction((transaction) =>
        writeLink(transaction, credentials, identity, userId, {
          ...proof,
          credentialId,
        }),
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

    /**
     * A one-time code for the signed-in `userId`. The link is made when the code arrives from the
     * person's account at `provider` (redeemChallenge), and always links to the user it was issued
     * to, so a code started by somebody else can never attach their account to this person.
     */
    async issueChallenge(
      userId: string,
      provider: IdentityProvider,
    ): Promise<{ code: string; expiresAt: Date }> {
      if (!userId.trim()) throw new IdentityInputError();
      if (
        !isIdentityProvider(provider) ||
        !acceptsMethod(provider, "challenge")
      )
        throw new IdentityInputError(
          "This provider does not accept that kind of proof.",
        );
      const code = randomUUID();
      return database.transaction(async (transaction) => {
        // One live code per person per provider: a new one replaces any earlier one.
        await transaction
          .delete(identityLinkChallenges)
          .where(
            and(
              eq(identityLinkChallenges.userId, userId),
              eq(identityLinkChallenges.provider, provider),
            ),
          );
        // No sweep exists, so codes that were never sent would otherwise accumulate.
        await transaction
          .delete(identityLinkChallenges)
          .where(
            lt(
              identityLinkChallenges.expiresAt,
              sql`clock_timestamp() - interval '1 day'`,
            ),
          );
        const [challenge] = await transaction
          .insert(identityLinkChallenges)
          .values({
            tokenHash: codeHash(code),
            provider,
            userId,
            expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
          })
          .returning({ expiresAt: identityLinkChallenges.expiresAt });
        if (!challenge) throw new IdentityLinkError();
        return { code, expiresAt: challenge.expiresAt };
      });
    },

    /**
     * Link `value`, the chat account the code arrived from, to the user the code was issued to.
     * Consumption and link creation share one transaction: a refused link leaves the code unused.
     */
    async redeemChallenge(
      code: string,
      value: Identity,
      handle: string | null = null,
    ): Promise<IdentityLink> {
      const hash = codeHash(code);
      const identity = parseIdentity(value);
      return database.transaction(async (transaction) => {
        const [challenge] = await transaction
          .select()
          .from(identityLinkChallenges)
          .where(eq(identityLinkChallenges.tokenHash, hash))
          .for("update");
        if (!challenge || challenge.provider !== identity.provider)
          throw new IdentityLinkError();
        // The real clock after the row lock, not the transaction's start time.
        const [consumed] = await transaction
          .delete(identityLinkChallenges)
          .where(
            and(
              eq(identityLinkChallenges.tokenHash, hash),
              gt(identityLinkChallenges.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ userId: identityLinkChallenges.userId });
        if (!consumed) throw new IdentityLinkError();
        return writeLink(transaction, credentials, identity, consumed.userId, {
          method: "challenge",
          handle: handle?.slice(0, 256) ?? null,
        });
      });
    },
  };
}

export type IdentityStore = ReturnType<typeof createIdentityStore>;
