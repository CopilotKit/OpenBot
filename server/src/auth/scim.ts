/**
 * SCIM 2.0 provisioning and deprovisioning, through Better Auth's own `@better-auth/scim` plugin.
 *
 * A directory (Okta, Entra, OneLogin, JumpCloud) is given `<BETTER_AUTH_URL>/api/auth/scim/v2` and
 * the bearer token in `SCIM_BEARER_TOKEN`. From then on:
 *
 * - Creating a user there creates the OpenBot user, with the `user` role (or `admin` for an address
 *   in INITIAL_ADMIN_EMAILS). They still sign in through the company's SSO; SCIM never creates a
 *   password or any other way in.
 * - Group membership there becomes `users.groups` here, which is what per-group capability switches
 *   and per-group network policies read (and what `channels.allowed_groups` was always waiting for).
 * - Deactivating or deleting the user there ends their sessions (the plugin does that) and, here,
 *   deny-lists the address, retires every connector credential they granted, and stops their Bots'
 *   computers. Reactivating them lifts a deny-list entry SCIM wrote, never one an administrator did.
 *
 * `SCIM_BEARER_TOKEN_NEXT` is accepted alongside the current token for rotation. Off entirely when
 * `SCIM_BEARER_TOKEN` is unset.
 */
import type { SCIMOptions } from "@better-auth/scim";
import { eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { revokedAccess, userRoles, users } from "../db/schema";
import { enterpriseControls } from "../admin/controls";
import { roleForEmail } from "./roles";

export const SCIM_REVOKED_BY_PREFIX = "scim:";

export function scimStatus(env: Record<string, string | undefined>) {
  const configured = Boolean(env.SCIM_BEARER_TOKEN?.trim());
  const base = env.BETTER_AUTH_URL?.trim().replace(/\/$/, "");
  return {
    configured,
    connectionId: env.SCIM_CONNECTION_ID?.trim() || "directory",
    baseUrl: base ? `${base}/api/auth/scim/v2` : null,
    rotating: Boolean(env.SCIM_BEARER_TOKEN_NEXT?.trim()),
  };
}

export type ScimDeps = {
  database: Database;
  auditStore?: AuditStore;
  initialAdminEmails: readonly string[];
};

async function emailOf(database: Database, userId: string) {
  const [row] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email;
}

/**
 * React to a person becoming inactive or active in the directory.
 *
 * Called inside the plugin's transaction, so nothing here touches the rows that transaction holds
 * (`users`, `sessions`, the SCIM tables): the deny-list is its own table, and everything slower runs
 * after the hook returns. Deny-listing before the transaction commits errs toward refusing; a
 * rolled-back deactivation is undone by the directory's next retry setting them active again.
 */
export async function reconcileDirectoryState(
  deps: ScimDeps,
  state: { userId: string; active: boolean },
): Promise<void> {
  const email = await emailOf(deps.database, state.userId);
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  const by = `${SCIM_REVOKED_BY_PREFIX}directory`;

  if (!state.active) {
    const inserted = await deps.database
      .insert(revokedAccess)
      .values({ email: normalized, revokedBy: by })
      .onConflictDoNothing()
      .returning({ email: revokedAccess.email });
    setTimeout(() => {
      void (async () => {
        await enterpriseControls()?.offboard(state.userId, by);
        if (deps.auditStore && inserted.length > 0) {
          await recordAuditEvent(deps.auditStore, {
            eventType: "person.deprovisioned",
            targetType: "person",
            targetId: state.userId,
            payload: {
              email,
              via: "SCIM",
              note: "Sessions ended, address deny-listed, connector credentials retired, computers stopped.",
            },
          });
        }
      })().catch((error) =>
        console.error(
          JSON.stringify({
            type: "scim-offboard-failed",
            error: String(error),
          }),
        ),
      );
    }, 0);
    return;
  }

  const [entry] = await deps.database
    .select({ revokedBy: revokedAccess.revokedBy })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, normalized))
    .limit(1);
  // An administrator's removal stands until an administrator lifts it.
  if (entry?.revokedBy.startsWith(SCIM_REVOKED_BY_PREFIX)) {
    await deps.database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, normalized));
    if (deps.auditStore) {
      await recordAuditEvent(deps.auditStore, {
        eventType: "person.reprovisioned",
        targetType: "person",
        targetId: state.userId,
        payload: { email, via: "SCIM" },
      }).catch(() => undefined);
    }
  }
}

/** The plugin's options, or undefined when SCIM is not configured. */
export function scimOptions(
  deps: ScimDeps,
  env: Record<string, string | undefined> = process.env,
): SCIMOptions | undefined {
  const token = env.SCIM_BEARER_TOKEN?.trim();
  if (!token) return undefined;
  const next = env.SCIM_BEARER_TOKEN_NEXT?.trim();
  const connectionId = env.SCIM_CONNECTION_ID?.trim() || "directory";

  return {
    connections: [
      {
        id: connectionId,
        credentials: [
          { type: "bearer", id: `${connectionId}-primary`, token },
          ...(next
            ? [
                {
                  type: "bearer" as const,
                  id: `${connectionId}-next`,
                  token: next,
                },
              ]
            : []),
        ],
      },
    ],
    identity: {
      reconcileUser: async (state) => {
        await reconcileDirectoryState(deps, state);
      },
    },
    /*
     * Groups become `users.groups`. The role projection maps each SCIM Group to its display name as
     * an opaque "role" slug, which is the plugin's supported way to hand group membership to the
     * application; `reconcileUser` then writes the complete set, so a removal from a group removes it
     * here too. The OpenBot role (admin/user) is never taken from the directory.
     */
    projection: {
      roles: {
        map: ({ source }) => [source.displayName],
        exists: () => true,
      },
      reconcileUser: async (projected, { database }) => {
        const groups = [
          ...new Set(projected.grants.map((grant) => grant.role)),
        ].sort();
        await database.update({
          model: "user",
          where: [{ field: "id", value: projected.userId }],
          update: { groups },
        });
      },
    },
    compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
  };
}

/**
 * A person SCIM just created: give them their role, and say so.
 *
 * Better Auth's `user.create.after` hook seeds the role for every new user, SCIM ones included; this
 * only writes the trail row, called from that hook when the user arrived with no provider account.
 */
export async function recordProvisioned(
  deps: ScimDeps,
  user: { id: string; email: string },
): Promise<void> {
  if (!deps.auditStore) return;
  const [role] = await deps.database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, user.id))
    .limit(1);
  await recordAuditEvent(deps.auditStore, {
    eventType: "person.provisioned",
    targetType: "person",
    targetId: user.id,
    payload: {
      email: user.email,
      via: "SCIM",
      role: role?.role ?? roleForEmail(user.email, deps.initialAdminEmails),
    },
  }).catch(() => undefined);
}
