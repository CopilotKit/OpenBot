import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth, okta } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  ssoProviders,
  users,
  verifications,
} from "../db/schema";
import { encryptSsoConfig } from "./encrypt-sso-config";
import { applyConfiguredAdmin, seedRole } from "./roles";

/**
 * Write a row about a sign-in, and never let the writing of it stop one.
 *
 * These run inside Better Auth's own hooks, where a thrown error becomes a refused sign-in. A trail
 * that is briefly unavailable must not lock everybody out of the deployment, so the failure is
 * logged where an operator will see it and the sign-in continues.
 */
async function record(
  auditStore: AuditStore | undefined,
  event: AuditEventInput,
): Promise<void> {
  if (!auditStore) return;
  try {
    await recordAuditEvent(auditStore, event);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "sign-in-audit-write-failed",
        eventType: event.eventType,
        error: String(error),
      }),
    );
  }
}

/**
 * An address for somebody arriving from Entra, whatever claim it turned up in.
 *
 * Entra does not always send `email`. Microsoft return it only when the profile carries an email
 * attribute, and for a multi-tenant application optional claims may not arrive at all, because an
 * external user's token is minted by their own tenant and does not inherit this application's claim
 * configuration. `common`, the default tenant here, is multi-tenant.
 *
 * Better Auth maps `email` straight through with no fallback, so on those deployments it is
 * undefined. That matters more here than in most products: every authorization decision OpenBot
 * makes about a person is keyed on their address. `INITIAL_ADMIN_EMAILS`, the role, the deny list
 * and the People screen all read it, so an absent address is not a cosmetic gap. Somebody would
 * sign in successfully, match no administrator, and land as a plain user with nothing on any screen
 * explaining why.
 *
 * `upn` first because it is the directory's own name for the account, then `preferred_username`,
 * which the OIDC spec explicitly does not promise is an address but which Entra populates with the
 * UPN in practice. Returning nothing when neither is present is deliberate: Better Auth then
 * refuses the sign-in, and being refused is a far better answer than being quietly admitted as
 * somebody the deployment cannot recognise.
 */
export function mapEntraProfile(profile: Record<string, unknown>) {
  const claim = (name: string) => {
    const value = profile[name];
    return typeof value === "string" && value.includes("@") ? value : undefined;
  };

  const email = claim("email") ?? claim("upn") ?? claim("preferred_username");
  if (!email) {
    console.error(
      JSON.stringify({
        type: "entra-profile-missing-email",
        note: "Entra returned no email, upn or preferred_username claim, so this person cannot be identified. Add `email` as an optional claim on the app registration, or use a single-tenant MICROSOFT_OAUTH_TENANT_ID.",
        claims: Object.keys(profile),
      }),
    );
    return {};
  }

  return { email };
}

export function createAuth(
  config: DeploymentConfig,
  database: Database,
  /**
   * Whether an administrator has removed this address.
   *
   * Checked here rather than only in the request guard, because a removed person whose sign-in
   * still succeeds gets a session, a user row and a place in the list: the removal would read as
   * having worked while quietly not having.
   */
  isRevoked?: (email: string) => Promise<boolean>,
  /**
   * Where getting in, and being turned away, are written down.
   *
   * Sign-in was the one thing this deployment did that left no trace. Two questions could not be
   * answered at all: who granted themselves the administrator role by editing the configuration, and
   * whether a person somebody has just removed had ever been here, because removing them deletes the
   * sessions that were the only evidence.
   *
   * Optional and never fatal. A trail that is unavailable must not stop somebody signing in, so every
   * write below is guarded and its failure is logged rather than raised.
   */
  auditStore?: AuditStore,
) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("No identity provider is configured.");
  }

  /*
   * Okta goes through the generic OAuth plugin, the other two do not.
   *
   * Google and Entra are named providers that Better Auth knows the endpoints of. Okta is not one
   * place: every customer has their own issuer, so it is OIDC discovery against a URL rather than a
   * provider with a fixed address. The plugin is only registered when Okta is configured, so a
   * deployment that does not use it carries no extra routes.
   *
   * They converge again at the browser: `signIn.social({ provider })` starts all three, so the
   * sign-in screen has one code path and does not need to know which kind each provider is.
   */
  const plugins = [
    ...(authConfig.okta
      ? [
          genericOAuth({
            config: [
              okta({
                clientId: authConfig.okta.clientId,
                clientSecret: authConfig.okta.clientSecret,
                issuer: authConfig.okta.issuer,
              }),
            ],
          }),
        ]
      : []),
    /*
     * Identity providers a company registers while this is running, by SAML or OIDC.
     *
     * Always on, unlike the three above, because it has nothing to configure: what it can do
     * depends entirely on what an administrator has registered, and an empty table means it offers
     * nothing. Turning it on and off would only mean a deployment could hold a registered IdP that
     * silently stopped working.
     *
     * `provisionUser` runs when somebody arrives through one of them. Their role has to be written
     * here or they land with no role at all and the request guard refuses them with a 403, which
     * reads as a broken deployment rather than a first sign-in.
     */
    sso({
      provisionUser: async ({ user }) => {
        await seedRole(
          database,
          user.id,
          user.email,
          authConfig.initialAdminEmails,
        );
      },
    }),
  ];

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    /*
     * Wrapped, so a company's client secret is ciphertext in the column.
     *
     * The SSO plugin writes `oidc_config` and `saml_config` as plaintext JSON, and the client secret
     * for a customer's directory is inside them. Every other secret this deployment keeps goes
     * through `KEY_ENCRYPTION_KEY`; these two were the exception. See encrypt-sso-config.ts.
     */
    database: encryptSsoConfig(
      drizzleAdapter(database, {
        provider: "pg",
        usePlural: true,
        schema: { users, sessions, accounts, verifications, ssoProviders },
      }),
      config.keyEncryptionKey,
    ),
    account: {
      /*
       * The provider's access and refresh tokens, encrypted at rest.
       *
       * Better Auth's own mechanism, which uses `BETTER_AUTH_SECRET` rather than
       * `KEY_ENCRYPTION_KEY`. Deliberately theirs: it encrypts on the way into storage and decrypts
       * on the way out, in the one place that knows every path a token takes, and hand-rolling that
       * inside somebody else's storage layer is how rows become permanently unreadable. It also
       * tolerates the plaintext already in the column, so switching it on does not invalidate the
       * accounts of everybody who has already signed in.
       */
      encryptOAuthTokens: true,
    },
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
      ...(authConfig.microsoft
        ? {
            microsoft: {
              clientId: authConfig.microsoft.clientId,
              clientSecret: authConfig.microsoft.clientSecret,
              tenantId: authConfig.microsoft.tenantId,
              mapProfileToUser: mapEntraProfile,
            },
          }
        : {}),
    },
    databaseHooks: {
      user: {
        create: {
          /*
           * Refuse before the account exists.
           *
           * Somebody removed and then signing in again would otherwise arrive as a brand-new person
           * with a fresh id, no role and no memory of having been removed, which is why the deny
           * list is keyed on the address rather than the id.
           */
          before: async (user) => {
            if (await isRevoked?.(user.email)) {
              // The row a removed person coming back produces. Nothing else records the attempt:
              // no user row is written and no session exists to look at afterwards.
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: user };
          },
          after: async (user) => {
            /*
             * Who is an administrator is decided by email, not by which provider signed them in. A
             * deployment mid-migration has the same person arriving through Entra one week and
             * Okta the next, and they are the same person to this list.
             */
            await seedRole(
              database,
              user.id,
              user.email,
              authConfig.initialAdminEmails,
            );
          },
        },
      },
      session: {
        create: {
          /*
           * And again for somebody who already has an account. The user hook above only fires for a
           * new one, so without this a removed person signs straight back in.
           */
          before: async (session) => {
            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);
            if (user && (await isRevoked?.(user.email))) {
              await record(auditStore, {
                eventType: "session.refused",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user.email,
                  reason: "access removed by an administrator",
                },
              });
              throw new APIError("FORBIDDEN", {
                message: "Your access to this deployment has been removed.",
              });
            }
            return { data: session };
          },
          after: async (session) => {
            /*
             * The configured floor, re-applied on every sign-in. Editing the list has to mean
             * something for people already in the table, or adding yourself after you first signed
             * in silently does nothing. Only promotes, and only addresses the list names: everybody
             * else's role belongs to the admin screen.
             */
            const promoted = await applyConfiguredAdmin(
              database,
              session.userId,
              authConfig.initialAdminEmails,
            );

            const [user] = await database
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, session.userId))
              .limit(1);

            /*
             * The promotion, on the trail.
             *
             * The floor is applied silently by design, which meant anybody who could edit
             * `INITIAL_ADMIN_EMAILS` made themselves an administrator and nothing anywhere said so.
             * Written only when the role actually changed, so a returning administrator does not
             * produce one of these on every sign-in.
             */
            if (promoted) {
              await record(auditStore, {
                eventType: "person.admin_by_configuration",
                targetType: "person",
                targetId: session.userId,
                actorUserId: session.userId,
                payload: {
                  email: user?.email,
                  reason:
                    "this address is named in INITIAL_ADMIN_EMAILS, so the configuration granted it",
                },
              });
            }

            await record(auditStore, {
              eventType: "session.signed_in",
              targetType: "person",
              targetId: session.userId,
              actorUserId: session.userId,
              payload: { email: user?.email },
            });
          },
        },
      },
    },
  });
}
