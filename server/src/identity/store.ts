/**
 * A person's linked outside accounts, and the one-time codes that link them.
 *
 * The links live in Intelligence's organization directory (people/directory), which enforces what the
 * local unique indexes used to: an outside account belongs to at most one person, a person has at most
 * one account per (provider, realm), and a vault row backs at most one link. A link write there is one
 * atomic step, and it answers with the vault rows no link holds any more, which are revoked here.
 *
 * The codes stay in this deployment's database: a code lasts ten minutes, is used once, and losing one
 * loses only a link somebody was about to make (they ask for another). They are in-flight work.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { CredentialRefusedError, type CredentialStore } from "../credentials";
import type { Database } from "../db/client";
import { identityLinkChallenges } from "../db/schema";
import {
  CredentialTakenError,
  IdentityLinkedElsewhereError,
  idempotencyKey,
  PersonDeletedError,
  PersonMissingError,
} from "../people/directory/client";
import { people } from "../people/directory/directory";
import type { LinkedIdentityRecord } from "../people/directory/types";
import { vault } from "../vault/directory";
import {
  acceptsMethod,
  isIdentityProvider,
  PROVIDERS,
  parseIdentity,
} from "./providers";
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
type Locker = Pick<Transaction, "execute">;

/**
 * The per-person identity lock: a transaction-scoped advisory lock on `userId`. issueChallenge
 * takes it, and person removal (retireIdentityLinks) is meant to take the same key, so a link code
 * is issued wholly before a removal (which then deletes it) or wholly after, never alongside.
 */
export async function identityUserLock(transaction: Locker, userId: string) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`identity-user\u001f${userId}`}, 0))`,
  );
}

/** `provider` is the record's provider, already checked against the registry by the caller. */
function toLink(
  record: LinkedIdentityRecord,
  provider: IdentityProvider,
): IdentityLink {
  return {
    id: record.id,
    provider,
    realm: record.realm,
    subject: record.subject,
    userId: record.userId,
    handle: record.handle,
    verifiedBy: record.verifiedBy,
    credentialId: record.credentialId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Revoke vault secrets the directory says no link holds any more. Already revoked is the outcome
 * wanted. Called with no transaction open: the vault is Intelligence's.
 */
async function revokeReleased(
  credentials: Revoke,
  released: readonly string[],
) {
  for (const id of released) {
    try {
      await credentials.revoke(id);
    } catch (error) {
      if (!(error instanceof CredentialRefusedError)) throw error;
    }
  }
}

const HANDLE_MAX = 256;

/**
 * One rule for a display handle on every path: omitted (`undefined`) keeps what the link has,
 * null clears it, a string is trimmed and capped at 256 code points (never splitting a surrogate
 * pair), and a blank one becomes null. Anything else is refused.
 */
function normalizeHandle(handle: unknown): string | null | undefined {
  if (handle === undefined || handle === null) return handle;
  if (typeof handle !== "string") throw new IdentityInputError();
  const trimmed = handle.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, HANDLE_MAX).join("");
}

/** A user id is an opaque, non-blank string with no surrounding whitespace, never coerced. */
function requireUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || !userId.trim() || userId !== userId.trim())
    throw new IdentityInputError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CREDENTIAL_UNAVAILABLE = "The credential for this link is not available.";

/**
 * Whether `credentialId` may back a link to this provider: a live vault secret that is the provider's
 * own user token (kind "connector", vault provider equal to the registry's `credentialProvider`), so a
 * link can never adopt, and a later unlink or replace never revoke, some other secret such as an
 * operator key. That no other link holds it is the directory's to enforce, in the link write itself.
 * Read through this instance's vault directory to Intelligence.
 */
async function requireLinkableCredential(
  provider: IdentityProvider,
  credentialId: string,
) {
  const credentialProvider = PROVIDERS[provider].credentialProvider;
  if (!credentialProvider) throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
  const live = await vault().findSecret(credentialId);
  if (
    !live ||
    live.revokedAt !== null ||
    live.kind !== "connector" ||
    live.provider !== credentialProvider
  )
    throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
}

/**
 * Link `identity` to `userId` in the directory. Module-private: only `linkVerified` (which checks the
 * proof's method against the provider and the credential's shape and kind first; the proof itself is
 * the caller's to verify) and `redeemChallenge` (no credential) call it.
 *
 * Linked to somebody else: refused. Linked to this person: verified again. Otherwise this person's
 * older link in the same realm, if any, is replaced. Credential and handle: `undefined` keeps what the
 * link has, a new credential replaces the old one. Whatever vault rows the directory releases are
 * revoked here, after it has answered.
 */
async function writeLink(
  credentials: Revoke,
  identity: Identity,
  userId: string,
  proof: {
    method: LinkMethod;
    handle?: string | null;
    credentialId?: string;
  },
): Promise<IdentityLink> {
  let written: Awaited<
    ReturnType<ReturnType<typeof people>["client"]["linkIdentity"]>
  >;
  try {
    written = await people().client.linkIdentity(
      {
        userId,
        provider: identity.provider,
        realm: identity.realm,
        subject: identity.subject,
        verifiedBy: proof.method,
        ...(proof.handle === undefined ? {} : { handle: proof.handle }),
        ...(proof.credentialId === undefined
          ? {}
          : { credentialId: proof.credentialId }),
      },
      idempotencyKey("link-identity"),
    );
  } catch (error) {
    if (error instanceof IdentityLinkedElsewhereError)
      throw new IdentityConflictError();
    if (error instanceof CredentialTakenError)
      throw new IdentityInputError(CREDENTIAL_UNAVAILABLE);
    if (
      error instanceof PersonMissingError ||
      error instanceof PersonDeletedError
    )
      throw new IdentityInputError();
    throw error;
  }
  await revokeReleased(credentials, written.released);
  return toLink(written.identity, identity.provider);
}

/** Refuses anything that is not a code OpenBot could have issued before it reaches a query. */
function codeHash(code: string) {
  if (typeof code !== "string" || !UUID.test(code))
    throw new IdentityLinkError();
  return createHash("sha256").update(code.toLowerCase()).digest("hex");
}

export function createIdentityStore(database: Database, credentials: Revoke) {
  return {
    /**
     * Who `value` is linked to, and the link's status. A removed person's links persist by design
     * (retirement marks them needs_reconnect rather than deleting them, so the outside account
     * keeps resolving to the removed person and is refused rather than becoming a guest), so
     * callers must also check the returned user is still an active person before acting for them.
     */
    async linkedUser(
      value: Identity,
    ): Promise<{ userId: string; status: LinkStatus } | null> {
      const identity = parseIdentity(value);
      const [link] = await people().client.listIdentities({
        provider: identity.provider,
        realm: identity.realm,
        subject: identity.subject,
      });
      return link ? { userId: link.userId, status: link.status } : null;
    },

    async identitiesFor(
      userId: string,
      provider?: IdentityProvider,
    ): Promise<IdentityLink[]> {
      const rows = (
        await people().client.listIdentities({
          userId,
          ...(provider ? { provider } : {}),
        })
      ).sort((a, b) =>
        a.provider === b.provider
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : a.provider < b.provider
            ? -1
            : 1,
      );
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
     * A `credentialId`, when given, must be a UUID naming a live credential that is this
     * provider's own user token (see `credentialProvider`) and that no other link holds (the
     * directory refuses one another link holds, in the link write itself), so a malformed, missing,
     * revoked, foreign or already-owned id is refused rather than stored as a token the link does not
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
      requireUserId(userId);
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
      const handle = normalizeHandle(proof.handle);
      if (credentialId)
        await requireLinkableCredential(identity.provider, credentialId);
      return writeLink(credentials, identity, userId, {
        method: proof.method,
        handle,
        credentialId,
      });
    },

    async markNeedsReconnect(linkId: string): Promise<void> {
      await people().client.updateIdentity(
        linkId,
        { status: "needs_reconnect" },
        idempotencyKey("identity-needs-reconnect"),
      );
    },

    /** The removed link's provider as stored, or null when the asker has no such link. */
    async unlink(
      userId: string,
      linkId: string,
    ): Promise<{ provider: string } | null> {
      const removed = await people().client.unlinkIdentity(
        userId,
        linkId,
        idempotencyKey("unlink-identity"),
      );
      if (!removed) return null;
      await revokeReleased(credentials, removed.released);
      return { provider: removed.identity.provider };
    },

    /**
     * A one-time code for the signed-in `userId`. The link is made when the code arrives from the
     * person's account at `provider` (redeemChallenge), and always links to the user it was issued
     * to, so a code started by somebody else can never attach their account to this person.
     *
     * Issued under identityUserLock, the lock person removal takes, so a code is never issued
     * alongside a removal: one issued before it is deleted by it. A code issued after a removal
     * (by a caller that skipped its session check) can still link, but only to the removed person,
     * whom linkedUser's callers must refuse.
     */
    async issueChallenge(
      userId: string,
      provider: IdentityProvider,
    ): Promise<{ code: string; expiresAt: Date }> {
      requireUserId(userId);
      if (
        !isIdentityProvider(provider) ||
        !acceptsMethod(provider, "challenge")
      )
        throw new IdentityInputError(
          "This provider does not accept that kind of proof.",
        );
      const code = randomUUID();
      return database.transaction(async (transaction) => {
        await identityUserLock(transaction, userId);
        // Nothing else deletes an expired code (a person has at most one per provider, but one
        // never redeemed stays forever), so each issue clears those over a day stale.
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
          // One live code per person per provider, enforced by the unique index: a new code
          // replaces any earlier one, even when two requests race.
          .onConflictDoUpdate({
            target: [
              identityLinkChallenges.userId,
              identityLinkChallenges.provider,
            ],
            set: {
              tokenHash: sql`excluded.token_hash`,
              expiresAt: sql`excluded.expires_at`,
            },
          })
          .returning({ expiresAt: identityLinkChallenges.expiresAt });
        // An upsert always returns its row; this only narrows the type.
        if (!challenge) throw new Error("The link code was not stored.");
        return { code, expiresAt: challenge.expiresAt };
      });
    },

    /**
     * Cancel a live `provider` code without linking anything, for a code exposed where others could
     * read it. Returns whether a live code was removed: false for a malformed, unknown, expired or
     * other-provider code, which is left as it was.
     */
    async discardChallenge(
      code: string,
      provider: IdentityProvider,
    ): Promise<boolean> {
      if (typeof code !== "string" || !UUID.test(code)) return false;
      const hash = codeHash(code);
      const removed = await database
        .delete(identityLinkChallenges)
        .where(
          and(
            eq(identityLinkChallenges.tokenHash, hash),
            eq(identityLinkChallenges.provider, provider),
            gt(identityLinkChallenges.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ provider: identityLinkChallenges.provider });
      return removed.length > 0;
    },

    /**
     * Link `value`, the chat account the code arrived from, to the user the code was issued to.
     *
     * The code is consumed first, in a transaction of its own, so it is used once however many times
     * it arrives at once; the link is then written to the directory with no transaction open. A refused
     * link puts the code back, so it is left unused, unless a newer code for the same person has been
     * issued meanwhile. `handle` follows the same rule as linkVerified: omitted keeps the stored one,
     * null clears.
     */
    async redeemChallenge(
      code: string,
      value: Identity,
      handle?: string | null,
    ): Promise<IdentityLink> {
      const hash = codeHash(code);
      const identity = parseIdentity(value);
      const normalized = normalizeHandle(handle);
      const consumed = await database.transaction(async (transaction) => {
        const [challenge] = await transaction
          .select()
          .from(identityLinkChallenges)
          .where(eq(identityLinkChallenges.tokenHash, hash))
          .for("update");
        if (!challenge || challenge.provider !== identity.provider)
          throw new IdentityLinkError();
        // The real clock after the row lock, not the transaction's start time.
        const [taken] = await transaction
          .delete(identityLinkChallenges)
          .where(
            and(
              eq(identityLinkChallenges.tokenHash, hash),
              gt(identityLinkChallenges.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning();
        if (!taken) throw new IdentityLinkError();
        return taken;
      });
      try {
        return await writeLink(credentials, identity, consumed.userId, {
          method: "challenge",
          handle: normalized,
        });
      } catch (error) {
        await database
          .insert(identityLinkChallenges)
          .values(consumed)
          .onConflictDoNothing();
        throw error;
      }
    },
  };
}

export type IdentityStore = ReturnType<typeof createIdentityStore>;
