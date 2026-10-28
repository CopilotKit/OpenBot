import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers } from "../src/db/schema";
import type { BrokerApp } from "../src/plugins/broker";
import { backfillBrokeredLogos } from "../src/plugins/logos";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const ids: string[] = [];
afterEach(async () => {
  for (const id of ids.splice(0))
    await database.delete(mcpServers).where(eq(mcpServers.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

async function server(
  logo: string | null,
  provenance = "composio",
  urlOf = (id: string) => `composio://${id}`,
) {
  const id = `logo-${randomUUID()}`;
  await database.insert(mcpServers).values({
    id,
    title: "Example",
    vendor: "Composio",
    url: urlOf(id),
    provenance,
    logo,
    authScheme: "API_KEY",
  });
  ids.push(id);
  return id;
}
function app(slug: string): BrokerApp {
  return {
    slug,
    name: "Example",
    description: "",
    logo: "https://example.com/logo.svg",
    categories: [],
    actionCount: 0,
    classifiedCount: null,
    permissionCount: null,
    scopedActionCount: null,
    connection: { kind: "fields", authScheme: "API_KEY" },
  };
}
async function row(id: string) {
  const [result] = await database
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return result;
}

test("fills existing brokered apps by their URL, preserving existing logos and schemes", async () => {
  const missing = await server(null);
  const existing = await server("https://example.com/existing.svg");
  const custom = await server(null, "custom");
  await backfillBrokeredLogos(database, "composio", {
    listApps: async () => [app(missing), app(existing), app(custom)],
  });
  expect((await row(missing))?.logo).toBe("https://example.com/logo.svg");
  expect((await row(missing))?.authScheme).toBe("API_KEY");
  expect((await row(existing))?.logo).toBe("https://example.com/existing.svg");
  expect((await row(custom))?.logo).toBeNull();
});

test("catalogue errors preserve the saved app and propagate to the startup warning", async () => {
  const id = await server(null);
  await expect(
    backfillBrokeredLogos(database, "composio", {
      listApps: async () => {
        throw new Error("Catalogue unavailable");
      },
    }),
  ).rejects.toThrow("Catalogue unavailable");
  expect((await row(id))?.logo).toBeNull();
  expect((await row(id))?.authScheme).toBe("API_KEY");
});

test("an arcade-provenanced row is filled when the call passes arcade", async () => {
  const id = await server(null, "arcade", () => "arcade://Gmail");
  await backfillBrokeredLogos(database, "arcade", {
    listApps: async () => [app("Gmail")],
  });
  expect((await row(id))?.logo).toBe("https://example.com/logo.svg");
});

// This is what fails if the backfill is ever made provider-agnostic by widening the slice and trying both parsers; see `access.ts`'s `TOOLKIT_OF`.
test("the same arcade row is left untouched when the call passes composio", async () => {
  const id = await server(null, "arcade", () => "arcade://Gmail");
  await backfillBrokeredLogos(database, "composio", {
    listApps: async () => [app("Gmail")],
  });
  expect((await row(id))?.logo).toBeNull();
});
