import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuditTransaction } from "../audit";
import type { Database } from "../db/client";
import {
  externalUserLinks,
  revokedAccess,
  userRoles,
  users,
} from "../db/schema";
import type {
  ExternalProvider,
  ExternalProviderIdentity,
  ExternalUserLink,
} from "./schema-types";

export type ExternalLinkResult = {
  link: ExternalUserLink;
  created: boolean;
};

export type ExternalLinkStore = {
  find: (
    provider: ExternalProvider,
    tenantId: string,
    providerUserId: string,
  ) => Promise<ExternalUserLink | null>;
  findVerifiedUserByEmail: (
    email: string,
  ) => Promise<{ id: string; name: string } | null>;
  link: (
    input: ExternalProviderIdentity & { openbotUserId: string },
  ) => Promise<ExternalUserLink>;
};

/** Fresh OpenBot authorization state for an external identity already stored in the database. */
export type ExternalLinkAuthorizationStore = ExternalLinkStore & {
  resolveActiveUser: (openbotUserId: string) => Promise<{
    id: string;
    name: string;
    role: "admin" | "user";
  } | null>;
};

export type ExternalLinkCreationStore = ExternalLinkStore & {
  linkWithStatus: (
    input: ExternalProviderIdentity & { openbotUserId: string },
  ) => Promise<ExternalLinkResult>;
  linkWithStatusAndAudit: (
    input: ExternalProviderIdentity & { openbotUserId: string },
    recordAudit: (transaction: AuditTransaction) => Promise<void>,
  ) => Promise<ExternalLinkResult>;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asLink(row: typeof externalUserLinks.$inferSelect): ExternalUserLink {
  return {
    provider: row.provider as ExternalProvider,
    providerTenantId: row.providerTenantId,
    providerUserId: row.providerUserId,
    providerEmail: row.providerEmail,
    openbotUserId: row.openbotUserId,
    linkedAt: row.linkedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Which key an insert lost to. The two mean opposite things about who owns what.
 *
 * `provider_identity_linked` is a statement about somebody else's account: this Slack user is
 * already somebody's. `openbot_user_linked` is a statement about the caller's own: they are already
 * linked to a different Slack user in the same workspace. Collapsing them into one sentence told a
 * person re-linking under a new Slack id that their identity belonged to another OpenBot account,
 * which is a false claim about their own account and one they can do nothing about.
 */
export type ExternalLinkConflict =
  | "provider_identity_linked"
  | "openbot_user_linked";

export const EXTERNAL_LINK_CONFLICT_MESSAGES = {
  provider_identity_linked:
    "That Slack identity is already linked to another OpenBot account.",
  openbot_user_linked:
    "Your OpenBot account is already linked to a different Slack user in this workspace.",
} as const satisfies Record<ExternalLinkConflict, string>;

/** Carries which key it was, so the caller can say something true rather than something safe. */
export class ExternalLinkConflictError extends Error {
  readonly conflict: ExternalLinkConflict;

  constructor(conflict: ExternalLinkConflict) {
    super(EXTERNAL_LINK_CONFLICT_MESSAGES[conflict]);
    this.name = "ExternalLinkConflictError";
    this.conflict = conflict;
  }
}

export function createExternalLinkStore(
  database: Database,
): ExternalLinkCreationStore & ExternalLinkAuthorizationStore {
  async function find(
    provider: ExternalProvider,
    tenantId: string,
    providerUserId: string,
  ): Promise<ExternalUserLink | null> {
    const [row] = await database
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, provider),
          eq(externalUserLinks.providerTenantId, tenantId),
          eq(externalUserLinks.providerUserId, providerUserId),
        ),
      )
      .limit(1);
    return row ? asLink(row) : null;
  }

  async function findVerifiedUserByEmail(email: string) {
    const rows = await database
      .select({
        id: users.id,
        // User names predate the not-null requirement but callers need a stable display value.
        name: sql<string>`coalesce(${users.name}, '')`,
      })
      .from(users)
      .leftJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(${users.email})`),
      )
      .where(
        and(
          eq(sql`lower(${users.email})`, normalizeEmail(email)),
          eq(users.emailVerified, true),
          isNull(revokedAccess.email),
        ),
      )
      .limit(2);

    return rows.length === 1 ? rows[0] : null;
  }

  async function resolveActiveUser(openbotUserId: string): Promise<{
    id: string;
    name: string;
    role: "admin" | "user";
  } | null> {
    const rows = await database
      .select({
        id: users.id,
        name: sql<string>`coalesce(${users.name}, '')`,
        role: userRoles.role,
      })
      .from(users)
      .leftJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(${users.email})`),
      )
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.id, openbotUserId), isNull(revokedAccess.email)));

    const user = rows[0];
    if (!user) return null;
    const roles = rows.map((row) => row.role);
    const role: "admin" | "user" | null = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : null;
    return role ? { id: user.id, name: user.name, role } : null;
  }

  async function linkWithStatusWithin(
    transaction: AuditTransaction,
    input: ExternalProviderIdentity & { openbotUserId: string },
  ): Promise<ExternalLinkResult> {
    const [inserted] = await transaction
      .insert(externalUserLinks)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { link: asLink(inserted), created: true };
    }

    const [row] = await transaction
      .select()
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, input.provider),
          eq(externalUserLinks.providerTenantId, input.providerTenantId),
          eq(externalUserLinks.providerUserId, input.providerUserId),
        ),
      )
      .limit(1);
    const existing = row ? asLink(row) : null;
    if (existing && existing.openbotUserId === input.openbotUserId) {
      return { link: existing, created: false };
    }
    if (existing) {
      throw new ExternalLinkConflictError("provider_identity_linked");
    }

    /*
     * `onConflictDoNothing` also covers the one-OpenBot-user-per-workspace key. When that key
     * won, the lookup above has no row because it is deliberately by provider identity; read the
     * other key before reporting the public conflict. Each statement observes committed work, so
     * this is also the answer after a concurrent insert has completed.
     */
    const [existingForUser] = await transaction
      .select({ openbotUserId: externalUserLinks.openbotUserId })
      .from(externalUserLinks)
      .where(
        and(
          eq(externalUserLinks.provider, input.provider),
          eq(externalUserLinks.providerTenantId, input.providerTenantId),
          eq(externalUserLinks.openbotUserId, input.openbotUserId),
        ),
      )
      .limit(1);
    if (existingForUser) {
      throw new ExternalLinkConflictError("openbot_user_linked");
    }

    throw new Error("External user link was not found after insertion.");
  }

  async function linkWithStatus(
    input: ExternalProviderIdentity & { openbotUserId: string },
  ): Promise<ExternalLinkResult> {
    return database.transaction((transaction) =>
      linkWithStatusWithin(transaction, input),
    );
  }

  async function linkWithStatusAndAudit(
    input: ExternalProviderIdentity & { openbotUserId: string },
    recordAudit: (transaction: AuditTransaction) => Promise<void>,
  ): Promise<ExternalLinkResult> {
    return database.transaction(async (transaction) => {
      const result = await linkWithStatusWithin(transaction, input);
      if (result.created) await recordAudit(transaction);
      return result;
    });
  }

  async function link(
    input: ExternalProviderIdentity & { openbotUserId: string },
  ): Promise<ExternalUserLink> {
    return (await linkWithStatus(input)).link;
  }

  return {
    find,
    findVerifiedUserByEmail,
    resolveActiveUser,
    link,
    linkWithStatus,
    linkWithStatusAndAudit,
  };
}
