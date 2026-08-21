import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { genericOAuth, okta } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { accounts, sessions, users, verifications } from "../db/schema";
import { applyConfiguredAdmin, seedRole } from "./roles";

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
  const plugins = authConfig.okta
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
    : [];

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    plugins,
    socialProviders: {
      ...(authConfig.google ? { google: authConfig.google } : {}),
      ...(authConfig.microsoft
        ? {
            microsoft: {
              clientId: authConfig.microsoft.clientId,
              clientSecret: authConfig.microsoft.clientSecret,
              tenantId: authConfig.microsoft.tenantId,
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
            await applyConfiguredAdmin(
              database,
              session.userId,
              authConfig.initialAdminEmails,
            );
          },
        },
      },
    },
  });
}
