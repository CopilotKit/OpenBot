import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be configured before running a database migration command",
  );
}

export default defineConfig({
  dialect: "postgresql",
  /**
   * Every schema file, listed explicitly.
   *
   * Files missing from this list are invisible to `generate`; existing tables still work, but the
   * next generated migration treats them as absent. Add the file here in the same change that adds
   * the schema file.
   */
  schema: [
    "./src/db/schema/core.ts",
    "./src/db/schema/computer.ts",
    "./src/db/schema/coworker.ts",
    "./src/db/schema/components.ts",
    "./src/db/schema/plugins.ts",
    "./src/db/schema/work.ts",
    "./src/db/schema/voice.ts",
    "./src/db/schema/learning.ts",
    "./src/db/schema/responsibilities.ts",
    "./src/db/schema/approvals.ts",
    "./src/db/schema/memory.ts",
    "./src/db/schema/proactive.ts",
    "./src/db/schema/demonstrations.ts",
    "./src/db/schema/delivery.ts",
    "./src/db/schema/group.ts",
    "./src/db/schema/admin.ts",
    "./src/db/schema/scim.ts",
    "./src/db/schema/lifecycle.ts",
    "./src/db/schema/passwords.ts",
    "./src/db/schema/team-bots.ts",
    "./src/db/schema/shared-use.ts",
    "./src/db/schema/identity.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
