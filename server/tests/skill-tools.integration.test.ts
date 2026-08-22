import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agents,
  mcpServers,
  mcpTools,
  skills,
  skillTools,
  users,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * A skill saying which tools it needs, and that saying so grants nothing.
 *
 * The declaration is the unit retrieval will select over: a model picks a skill from its summary, and
 * the skill says which tools to load. The property that has to hold for that to be safe is the one
 * asserted hardest here — anybody signed in may write a skill, so if naming a tool could make it
 * callable, writing a skill would be a way to grant yourself one.
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
const author = `user_author_${suite}`;
const bot = `agent_${suite}`;
const server = `server_${suite}`;
const skill = `skill-${suite}`;
const otherSkill = `other-skill-${suite}`;

/** Two tools on one server. The Bot below is granted the first and not the second. */
const heldRef = `${server}/search`;
const withheldRef = `${server}/delete_everything`;

const actor = { id: author, isAdmin: true };

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: author, email: `${author}@example.test`, name: author })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} })
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
    .values([
      { serverId: server, name: "search", description: "Find things." },
      {
        serverId: server,
        name: "delete_everything",
        description: "Do not.",
      },
    ])
    .onConflictDoNothing();

  // The Bot holds exactly one of the two.
  await store.grant("mcp", heldRef, bot, "admin@openbot.local");
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(inArray(skills.slug, [skill, otherSkill]));
  await database.delete(mcpServers).where(eq(mcpServers.id, server));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, author));
});

async function saveSkill(tools: string[] | undefined, slug = skill) {
  await store.installSkill({
    slug,
    title: "A test skill",
    summary: "For a test.",
    instructions: "Do the thing.",
    ownerUserId: null,
    ...(tools === undefined ? {} : { tools }),
    by: "admin@openbot.local",
  });
}

const declaredBy = async (slug: string) =>
  (await store.listSkills(actor)).find((row) => row.slug === slug)?.tools ?? [];

describe("a skill declaring the tools it needs", () => {
  test("keeps what it was given, and reads it back", async () => {
    await saveSkill([heldRef]);
    expect(await declaredBy(skill)).toEqual([heldRef]);
  });

  test("a second save says what the skill needs now, rather than adding to it", async () => {
    // A set the author is editing. Merging would leave removing one with no gesture for it.
    await saveSkill([withheldRef]);
    expect(await declaredBy(skill)).toEqual([withheldRef]);
  });

  test("saving without the field leaves the declarations alone", async () => {
    // So a caller written before this field existed does not silently clear one.
    await saveSkill(undefined);
    expect(await declaredBy(skill)).toEqual([withheldRef]);
  });

  test("an empty list is how a skill stops asking for anything", async () => {
    await saveSkill([]);
    expect(await declaredBy(skill)).toEqual([]);
  });

  test("refuses a ref naming no tool this deployment has seen", async () => {
    // A typo is an error where it was written, rather than a skill that quietly selects nothing.
    await expect(saveSkill([`${server}/no_such_tool`])).rejects.toBeInstanceOf(
      PluginRefusedError,
    );
  });

  test("refuses the whole save rather than keeping the refs that were fine", async () => {
    await saveSkill([heldRef]);
    await expect(
      saveSkill([heldRef, `${server}/no_such_tool`]),
    ).rejects.toBeInstanceOf(PluginRefusedError);
    // Unchanged, not half-written.
    expect(await declaredBy(skill)).toEqual([heldRef]);
  });

  test("duplicates in one save are stored once", async () => {
    await saveSkill([heldRef, heldRef]);
    expect(await declaredBy(skill)).toEqual([heldRef]);
  });
});

describe("declaring a tool is not granting it", () => {
  test("a declared tool the Bot does not hold is still not callable", async () => {
    /*
     * THE property. Any signed-in person may write a skill, which is only safe while writing one
     * adds no capability. If this ever fails, the one surface deliberately not an administrator's has
     * become the way around every surface that is.
     */
    await saveSkill([heldRef, withheldRef]);
    await store.grant("skill", skill, bot, "admin@openbot.local");

    const held = await store.listForAgent(bot);
    const callable = held.tools.map((tool) => tool.ref);

    expect(callable).toContain(heldRef);
    expect(callable).not.toContain(withheldRef);
  });

  test("the declaration still travels, so selection can intersect it", async () => {
    // Carried alongside what may be called rather than folded into it: the runtime needs to know what
    // the skill asked for in order to narrow, and narrowing is the opposite of widening.
    const held = await store.listForAgent(bot);
    const mine = held.skills.find((row) => row.slug === skill);
    expect(mine?.tools).toEqual([withheldRef, heldRef].sort());
  });

  test("granting a skill does not grant the tools it names", async () => {
    // Same property from the grant surface's side: the skill grant above added a skill and nothing
    // else, so the tool the Bot was never granted is still absent.
    const [row] = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.ref, withheldRef));
    expect(row).toBeDefined();

    const held = await store.listForAgent(bot);
    expect(held.tools.map((tool) => tool.ref)).not.toContain(withheldRef);
  });
});

describe("a skill going away", () => {
  test("takes its declarations with it", async () => {
    await saveSkill([heldRef], otherSkill);
    expect(await declaredBy(otherSkill)).toEqual([heldRef]);

    await store.uninstallSkill(otherSkill, "admin@openbot.local");

    const left = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.skillId, otherSkill));
    expect(left).toHaveLength(0);
  });
});
