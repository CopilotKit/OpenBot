/**
 * Bots live in Intelligence: this deployment's `agents` and `agent_profiles` tables get no writes.
 *
 * The two tables stay for one release so an upgrading deployment has rows to copy, and are read only
 * by that copy. Two guards: no server source outside the copy names either table, and a Bot's whole
 * life through the store (create, edit, duplicate, credential, delete) leaves both tables as they were
 * while Intelligence holds every step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import { removeBots, useTestBots } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made: string[] = [];

afterAll(async () => {
  await removeBots(made);
  await database.delete(users).where(inArray(users.id, owners));
  await database.$client.close();
});

const owners: string[] = [];

describe("the legacy Bot tables", () => {
  test("no server source names them except the upgrade copy and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set([
      "agents/bot-registry/upgrade.ts",
      "db/schema/core.ts",
      "db/schema/coworker.ts",
    ]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return /\bagentProfiles\b|\bagents as \w+|import \{[^}]*\bagents\b[^}]*\} from "[./]+(?:db\/schema)/.test(
        code,
      )
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a Bot's whole life through the store writes nothing to them", async () => {
    await useTestBots();
    const owner = `no-local-writes-${randomUUID()}`;
    owners.push(owner);
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
    const actor = { id: owner, role: "user" as const };
    const store = createAgentProfileStore(
      database,
      new URL("https://managed.example.test/ag-ui"),
    );
    const before = await tableCounts();

    const created = await store.create(actor, {
      name: "Lifecycle",
      title: "Tester",
      roleDescription: "Lives and dies in Intelligence.",
      visibility: "private",
    });
    made.push(created.id);
    await store.update(actor, created.id, {
      name: "Lifecycle, renamed",
      title: "Tester",
      roleDescription: "Still in Intelligence.",
      visibility: "public",
    });
    const copy = await store.duplicate(actor, created.id);
    made.push(copy.id);
    await store.issueCallbackToken(actor, created.id);
    await store.setPinned(actor, created.id, true);
    await store.softDelete(actor, created.id);

    expect(await tableCounts()).toEqual(before);
    const named = await database
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.id, [created.id, copy.id]));
    expect(named).toEqual([]);

    const registry = (await useTestBots()).registry;
    const held = await registry.get(created.id);
    expect(held).toMatchObject({
      name: "Lifecycle, renamed",
      visibility: "public",
      callbackTokenHash: expect.any(String),
    });
    expect(held?.deletedAt).not.toBeNull();
    expect(await registry.get(copy.id)).toMatchObject({
      name: "Lifecycle, renamed",
      ownerUserId: owner,
    });
  });
});

async function tableCounts() {
  const [agentRows] = await database.select({ n: count() }).from(agents);
  const [profileRows] = await database
    .select({ n: count() })
    .from(agentProfiles);
  return { agents: agentRows?.n, agentProfiles: profileRows?.n };
}
