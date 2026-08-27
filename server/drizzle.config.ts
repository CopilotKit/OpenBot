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
  ],
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
});
