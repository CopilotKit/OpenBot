/**
 * The Bot configuration lives in Intelligence: this deployment's old tables for it get no writes.
 *
 * Grants, Team Bot publications, audiences, assignments and consents; people's standing
 * instructions, hidden and pinned Bots, pauses, routing and declined defaults; the component
 * catalogue and playground source; skills and what they declare; and the tenant package record. The
 * tables stay for one release so an upgrading deployment has rows to copy, and only that copy reads
 * them. Two guards: no server source outside the copy imports one, and the features they backed,
 * used through their stores, leave every one of them as it was while Intelligence holds each step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count, getTableName, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createBotLifecycleStore } from "../src/agents/lifecycle";
import { createAuditStore } from "../src/audit";
import { createSandboxedStore } from "../src/components/sandboxed";
import { createComponentStore } from "../src/components/store";
import { MOVED_TO_INTELLIGENCE } from "../src/configuration/frozen-tables";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { createTeamBots } from "../src/team-bots/team-bots";
import { createUserInstructionsStore } from "../src/user-instructions";
import {
  removeBots,
  seedBot,
  storedAccess,
  storedPreferences,
  useTestConfiguration,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `frozen-owner-${suite}`;
const teammate = `frozen-teammate-${suite}`;
const bots: string[] = [];

afterAll(async () => {
  await removeBots(bots);
  await database.delete(users).where(inArray(users.id, [owner, teammate]));
  await database.$client.close();
});

const MOVED = new Set(Object.keys(MOVED_TO_INTELLIGENCE));

describe("the Bot configuration's old tables", () => {
  test("no server source imports one except the upgrade copy, its list and the schema", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set([
      "configuration/upgrade.ts",
      "configuration/frozen-tables.ts",
    ]);
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path) || path.startsWith("db/schema/")) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      const imported = [
        ...code.matchAll(
          /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"[./]+(?:db\/schema)[^"]*"/g,
        ),
      ].flatMap((match) =>
        (match[1] ?? "")
          .split(",")
          .map((name) =>
            name
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0]
              ?.trim(),
          )
          .filter((name): name is string => Boolean(name)),
      );
      const named = imported.filter((name) => MOVED.has(name));
      return named.length ? [`${path}: ${named.join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  test("the features they backed, used end to end, write nothing to them", async () => {
    const configuration = await useTestConfiguration();
    await database.insert(users).values([
      { id: owner, email: `${owner}@example.test`, name: "Owner" },
      { id: teammate, email: `${teammate}@example.test`, name: "Teammate" },
    ]);
    const bot = await seedBot({
      ownerUserId: owner,
      name: "Frozen Tables",
      roleDescription: "Reaches the whole team.",
      visibility: "private",
    });
    bots.push(bot.id);
    const before = await tableCounts();
    const auditStore = createAuditStore(database);

    // A person's preferences.
    await createUserInstructionsStore().write(
      owner,
      "Write in British English.",
    );
    const lifecycle = createBotLifecycleStore();
    await lifecycle.pause(owner, bot.id);
    await lifecycle.setNotify(owner, bot.id, "needs_input");
    await lifecycle.setRouting(owner, "progress", ["slack"]);

    // A Bot's access: a skill and its grant, a publication, an assignment, a consent.
    const plugins = createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore,
      credentials: { readSecret: async () => null } as never,
      encryptionKey: "x".repeat(44),
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    });
    const slug = `frozen-${suite}`;
    await plugins.installSkill({
      slug,
      title: "Frozen",
      summary: "Lives in Intelligence.",
      instructions: "Say so.",
      ownerUserId: null,
      by: owner,
    });
    await plugins.grant("skill", slug, bot.id, owner);
    const teamBots = createTeamBots({
      database,
      connectedServers: async () => new Set(),
    });
    await teamBots.publish({ id: owner, role: "user" }, bot.id, {
      audience: "team",
      emails: [],
      groups: [],
    });
    await teamBots.assign({ id: owner, role: "admin" }, bot.id, "*");
    await teamBots.consent(
      { id: teammate, role: "user" },
      bot.id,
      "gmail",
      "allow_once",
    );

    // The component catalogue and a playground component.
    const components = createComponentStore(database);
    const name = `FrozenCard${suite}`;
    await components.syncCatalogue([
      {
        name,
        title: "Frozen card",
        kind: "card",
        description: "Draws a frozen card.",
      },
    ]);
    await components.revoke(name, bot.id, owner);
    await components.grantFunction(name, "listAccounts", owner);
    const sandboxed = createSandboxedStore(database, auditStore);
    const authored = await sandboxed.save({
      slug: `frozen_${suite}`,
      title: "Frozen authored",
      description: "An authored card.",
      html: "<div>frozen</div>",
      css: "",
      jsFunctions: "",
      argumentSchema: {},
      sampleArguments: {},
      by: owner,
    });
    await sandboxed.publish(authored.name, owner);

    expect(await tableCounts()).toEqual(before);

    // And Intelligence holds every step.
    expect(await storedPreferences(owner)).toMatchObject({
      instructions: "Write in British English.",
      bots: [
        expect.objectContaining({
          botId: bot.id,
          pausedAt: expect.any(Date),
          notify: "needs_input",
        }),
      ],
      routes: [
        expect.objectContaining({ kind: "progress", transports: ["slack"] }),
      ],
    });
    expect(await storedPreferences(teammate)).toMatchObject({
      consents: [
        expect.objectContaining({
          botId: bot.id,
          serverId: "gmail",
          decision: "once",
        }),
      ],
    });
    const access = await storedAccess(bot.id);
    expect(access.grants.map((grant) => [grant.kind, grant.ref])).toEqual([
      ["skill", slug],
    ]);
    expect(access.publication?.audience).toBe("team");
    expect(access.assignments.map((assignment) => assignment.group)).toEqual([
      "*",
    ]);
    const component = await configuration.client.components.get(name);
    expect(component?.withheldFrom.map((entry) => entry.botId)).toEqual([
      bot.id,
    ]);
    expect(component?.functions.map((fn) => fn.name)).toEqual(["listAccounts"]);
    const stored = await configuration.client.components.get(authored.name);
    expect(stored?.source?.isPublished).toBe(true);
    expect((await configuration.client.skills.get(slug))?.title).toBe("Frozen");

    await plugins.uninstallSkill(slug, owner);
    await configuration.client.components.remove(name, `test:${randomUUID()}`);
    await configuration.client.components.remove(
      authored.name,
      `test:${randomUUID()}`,
    );
  });
});

async function tableCounts() {
  const counts: Record<string, number> = {};
  for (const table of Object.values(MOVED_TO_INTELLIGENCE)) {
    const [row] = await database.select({ n: count() }).from(table as PgTable);
    counts[getTableName(table as PgTable)] = row?.n ?? 0;
  }
  return counts;
}
