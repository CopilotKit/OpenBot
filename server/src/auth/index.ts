import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import {
  accounts,
  sessions,
  userRoles,
  users,
  verifications,
} from "../db/schema";
import { roleForEmail } from "./roles";

export function createAuth(config: DeploymentConfig, database: Database) {
  const authConfig = config.auth;
  if (!authConfig) {
    throw new Error("Google authentication is not configured.");
  }

  return betterAuth({
    baseURL: authConfig.baseUrl,
    secret: authConfig.secret,
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: "pg",
      usePlural: true,
      schema: { users, sessions, accounts, verifications },
    }),
    socialProviders: {
      google: authConfig.google,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await database
              .insert(userRoles)
              .values({
                userId: user.id,
                role: roleForEmail(user.email, authConfig.initialAdminEmails),
              })
              .onConflictDoNothing();
          },
        },
      },
    },
  });
}
