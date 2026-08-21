import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { genericOAuth, okta } from "better-auth/plugins";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { accounts, sessions, users, verifications } from "../db/schema";
import { reconcileRole, reconcileRoleForUserId } from "./roles";

export function createAuth(config: DeploymentConfig, database: Database) {
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
          after: async (user) => {
            /*
             * Who is an administrator is decided by email, not by which provider signed them in. A
             * deployment mid-migration has the same person arriving through Entra one week and
             * Okta the next, and they are the same person to this list.
             */
            await reconcileRole(
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
          after: async (session) => {
            /*
             * Again on every sign-in, not only the first. The list is a file an operator edits, and
             * editing it has to mean something for the people already in the table: otherwise
             * adding yourself after you first signed in silently does nothing.
             */
            await reconcileRoleForUserId(
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
