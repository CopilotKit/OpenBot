import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  skillTools,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * A skill install and its grant made as ONE act, and a ref this deployment has never seen.
 *
 * Both exist for the template import, which creates a Bot, installs the skills the template names
 * and grants them to it. Three writes, and either all of them happened or none did: a failure
 * partway leaves an orphan Bot holding half a skill set, the person clicks import again, and the
 * deployment now has two.
 *
 * The second half is the one worth being careful about. `allowUnknownTools` reads like a permission
 * flag and is not one — the property asserted hardest below is that a skill installed with it still
 * grants nothing, because a declaration and a grant are different things and the run-time offer is
 * their intersection.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const bot = `agent_${suite}`;
const server = `server_${suite}`;
const atomicSkill = `atomic-${suite}`;
const unknownSkill = `unknown-${suite}`;
const everySkill = [atomicSkill, unknownSkill];

/** One tool this deployment has actually seen, and one naming a connector nobody has connected. */
const seenRef = `${server}/search`;
const unseenRef = "google-drive/search_files";

const by = "admin@openbot.local";
const actor = { id: `user_${suite}`, isAdmin: true };

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "built_in", configuration: {} })
    .onConflictDoNothing();
  await database
    .insert(mcpServers)
    .values({
      id: server,
      title: "A test server",
      vendor: "Test",
      url: "https://mcp.example.invalid/v1",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({ serverId: server, name: "search", description: "Find things." })
    .onConflictDoNothing();
});

/*
 * The pool goes back, and this is not tidiness.
 *
 * `bun test` runs every file in one process, so a pool left open here is held for the rest of the
 * suite. Enough files doing that and the deployment's own PostgreSQL runs out of connections
 * partway through a later file, which reads as the run dying somewhere unrelated rather than as a
 * connection limit. Every other integration test here closes; these did not, and CI died at a
 * different file on each run until they did.
 */
afterAll(async () => {
  await database.delete(skills).where(inArray(skills.slug, everySkill));
  await database.delete(mcpServers).where(eq(mcpServers.id, server));
  await database.delete(agents).where(eq(agents.id, bot));

  await database.$client.close();
});

const skillRow = async (slug: string) =>
  (
    await database.select().from(skills).where(eq(skills.slug, slug)).limit(1)
  ).at(0);

const grantRow = async (kind: string, ref: string) =>
  (
    await database
      .select()
      .from(pluginGrants)
      .where(and(eq(pluginGrants.kind, kind), eq(pluginGrants.ref, ref)))
      .limit(1)
  ).at(0);

describe("an install that is part of a larger act", () => {
  test("a rollback takes the skill and its grant with it", async () => {
    /*
     * The failure the executor exists for. Without it the two writes commit as they are made, so a
     * later step throwing leaves a skill in the `/` menu and a Bot holding it, both belonging to an
     * import that never finished and neither reachable from anything that would clean them up.
     */
    await expect(
      database.transaction(async (transaction) => {
        await store.installSkill(
          {
            slug: atomicSkill,
            title: "Part of one act",
            summary: "For a test.",
            instructions: "Do the thing.",
            ownerUserId: null,
            tools: [seenRef],
            by,
          },
          transaction,
        );
        await store.grant("skill", atomicSkill, bot, by, transaction);

        // Whatever fails after the skills are in: the Bot's profile, a ledger row, a boundary that
        // will not compile. From here the transaction's only correct end is backwards.
        throw new Error("the step after the skills failed");
      }),
    ).rejects.toThrow("the step after the skills failed");

    expect(await skillRow(atomicSkill)).toBeUndefined();
    expect(await grantRow("skill", atomicSkill)).toBeUndefined();
    expect(
      await database
        .select()
        .from(skillTools)
        .where(eq(skillTools.skillId, atomicSkill)),
    ).toHaveLength(0);
  });

  test("a transaction that commits keeps both", async () => {
    // The other half: the executor must not quietly discard the writes it is handed.
    await database.transaction(async (transaction) => {
      await store.installSkill(
        {
          slug: atomicSkill,
          title: "Part of one act",
          summary: "For a test.",
          instructions: "Do the thing.",
          ownerUserId: null,
          tools: [seenRef],
          by,
        },
        transaction,
      );
      await store.grant("skill", atomicSkill, bot, by, transaction);
    });

    expect(await skillRow(atomicSkill)).toBeDefined();
    expect(await grantRow("skill", atomicSkill)).toBeDefined();
  });

  test("a caller passing no executor writes exactly where it wrote before", async () => {
    // The default is what keeps every existing caller — the Skills page, the package sync — unchanged.
    await store.installSkill({
      slug: atomicSkill,
      title: "Written on the pool",
      summary: "For a test.",
      instructions: "Do the thing.",
      ownerUserId: null,
      by,
    });
    expect((await skillRow(atomicSkill))?.title).toBe("Written on the pool");
  });
});

describe("a template naming a tool nothing here has connected", () => {
  test("is refused by default, because that is a typo guard for the hand-authored path", async () => {
    await expect(
      store.installSkill({
        slug: unknownSkill,
        title: "Names a connector nobody has added",
        summary: "For a test.",
        instructions: "Do the thing.",
        ownerUserId: null,
        tools: [unseenRef],
        by,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    expect(await skillRow(unknownSkill)).toBeUndefined();
  });

  test("installs when the caller says the refs may be unknown", async () => {
    /*
     * Every fresh deployment has connected nothing, so without this a template naming
     * `google-drive/search_files` could not be imported anywhere, and a template could only ship
     * skills for connectors it could guarantee — which is none of them.
     */
    await store.installSkill({
      slug: unknownSkill,
      title: "Names a connector nobody has added",
      summary: "For a test.",
      instructions: "Do the thing.",
      ownerUserId: null,
      tools: [unseenRef],
      allowUnknownTools: true,
      by,
    });

    const declared = (await store.listSkills(actor)).find(
      (row) => row.slug === unknownSkill,
    );
    expect(declared?.tools).toEqual([unseenRef]);
  });

  test("and the ref it stored is inert: declaring is still not granting", async () => {
    /*
     * THE property, and the reason `allowUnknownTools` is not a security relaxation. The run-time
     * offer is granted ∩ declared, so a ref that was never checked is also never callable — the Bot
     * holds this skill and is offered nothing from it.
     */
    await store.grant("skill", unknownSkill, bot, by);

    const held = await store.listForAgent(bot);
    expect(held.skills.map((row) => row.slug)).toContain(unknownSkill);
    expect(held.tools.map((tool) => tool.ref)).not.toContain(unseenRef);
  });

  test("skips the check and nothing else: a save with no refs at all still behaves", async () => {
    // The flag turns one refusal off. It must not become a general "write whatever" switch, so the
    // rest of the save — the replace-wholesale rule for declarations — is unchanged under it.
    await store.installSkill({
      slug: unknownSkill,
      title: "Names a connector nobody has added",
      summary: "For a test.",
      instructions: "Do the thing.",
      ownerUserId: null,
      tools: [],
      allowUnknownTools: true,
      by,
    });

    const declared = (await store.listSkills(actor)).find(
      (row) => row.slug === unknownSkill,
    );
    expect(declared?.tools).toEqual([]);
  });
});

describe("the HTTP path that anybody signed in may reach", () => {
  test("never sets allowUnknownTools", async () => {
    /*
     * Read from the source rather than exercised through a request, because what is being pinned is
     * that nobody adds it later. A behavioural test would pass the moment somebody threaded the flag
     * through from the request body and forgot what it was for.
     *
     * The Skills page is the hand-authored path, and there the refusal is the whole point: somebody
     * typing `google-drive/serach_files` should be told immediately rather than shipping a skill
     * that silently selects nothing. The flag belongs to the import module, which is reading a
     * document written against a deployment other than this one.
     */
    const source = await readFile(
      new URL("../src/plugins/routes.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("store.installSkill(");
    expect(source).not.toContain("allowUnknownTools");
  });
});
