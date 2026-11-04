import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { pluginGrants, skills, users } from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { removeBots, seedBot } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { useTestVault } from "./support/vault";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

let store: PluginStore;

const suite = randomUUID().slice(0, 8);
const alice = `user_alice_${suite}`;
const bob = `user_bob_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const sharedBot = `agent_shared_${suite}`;
const personalSlug = `standup-${suite}`;
const keptSlug = `kept-${suite}`;
const deploymentSlug = `triage-${suite}`;
const unwrittenSlug = `unwritten-${suite}`;
const botlessSlug = `botless-${suite}`;
const missingBot = `agent_missing_${suite}`;

beforeAll(async () => {
  store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(await useTestVault()),
    encryptionKey: "x".repeat(44),
    policy: () => policy,
  });
  for (const id of [alice, bob]) {
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id })
      .onConflictDoNothing();
  }
  for (const [id, owner] of [
    [aliceBot, alice],
    [sharedBot, null],
  ] as const) {
    await seedBot({
      id,
      name: id,
      ownerUserId: owner,
      title: id,
      roleDescription: "For a test.",
      avatarSeed: id,
      visibility: "private",
    });
  }
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [
        personalSlug,
        keptSlug,
        deploymentSlug,
        unwrittenSlug,
        botlessSlug,
      ]),
    );
  await removeBots([aliceBot, sharedBot]);
  await database.delete(users).where(inArray(users.id, [alice, bob]));
});

function routesAs(actor: {
  id: string;
  email: string;
  role: "admin" | "user";
}) {
  return createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    async () => true,
  );
}

const asAlice = () =>
  routesAs({ id: alice, email: `${alice}@example.test`, role: "user" });
const asBob = () =>
  routesAs({ id: bob, email: `${bob}@example.test`, role: "user" });
const asAdmin = () =>
  routesAs({
    id: `user_admin_${suite}`,
    email: "admin@example.test",
    role: "admin",
  });

type Routes = ReturnType<typeof routesAs>;

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const writeSkill = (
  routes: Routes,
  slug: string,
  instructions: string,
  global = false,
) =>
  routes.request(
    "/skills",
    post({ slug, title: slug, instructions, ...(global ? { global } : {}) }),
  );

const grant = (routes: Routes, ref: string, agentId: string) =>
  routes.request("/grants", post({ kind: "skill", ref, agentId }));

const uninstall = (routes: Routes, slug: string) =>
  routes.request(`/skills/${slug}`, { method: "DELETE" });

const offered = async (routes: Routes, agentId: string) => {
  const body = (await (await routes.request(`/for/${agentId}`)).json()) as {
    skills: { slug: string; instructions: string }[];
  };
  return body.skills.map(({ slug, instructions }) => ({ slug, instructions }));
};

describe("a skill name written again after the skill was uninstalled", () => {
  test("a person's Bot does not take on the next author's instructions", async () => {
    expect(
      (await writeSkill(asAlice(), personalSlug, "Alice's standup.")).status,
    ).toBe(200);
    expect(
      (await writeSkill(asAlice(), keptSlug, "Alice's other skill.")).status,
    ).toBe(200);
    expect((await grant(asAlice(), personalSlug, aliceBot)).status).toBe(200);
    expect((await grant(asAlice(), keptSlug, aliceBot)).status).toBe(200);

    expect((await uninstall(asAlice(), personalSlug)).status).toBe(200);
    expect(
      (await writeSkill(asBob(), personalSlug, "Bob's words.")).status,
    ).toBe(200);
    expect((await grant(asBob(), personalSlug, aliceBot)).status).toBe(403);

    expect(await offered(asAlice(), aliceBot)).toEqual([
      { slug: keptSlug, instructions: "Alice's other skill." },
    ]);
  });

  test("a Bot the deployment shares does not take on a person's instructions", async () => {
    expect(
      (await writeSkill(asAdmin(), deploymentSlug, "Triage by severity.", true))
        .status,
    ).toBe(200);
    expect((await grant(asAdmin(), deploymentSlug, sharedBot)).status).toBe(
      200,
    );

    expect((await uninstall(asAdmin(), deploymentSlug)).status).toBe(200);
    expect(
      (await writeSkill(asAlice(), deploymentSlug, "Alice's words.")).status,
    ).toBe(200);
    expect((await grant(asAlice(), deploymentSlug, sharedBot)).status).toBe(
      403,
    );

    expect(await offered(asAdmin(), sharedBot)).toEqual([]);
  });

  /*
   * The same room, entered before any skill exists rather than after one is uninstalled. An
   * administrator's grant skipped the existence check every other caller gets, and a Bot's skills are
   * read by slug alone, so the grant waited for whoever wrote a skill under that name next.
   */
  test("a shared Bot cannot be granted a skill nobody has written yet", async () => {
    const refused = await grant(asAdmin(), unwrittenSlug, sharedBot);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: `There is no skill called ${unwrittenSlug}.`,
    });

    expect(
      (await writeSkill(asAlice(), unwrittenSlug, "Alice's words.")).status,
    ).toBe(200);

    expect(await offered(asAdmin(), sharedBot)).toEqual([]);
  });

  /*
   * The other half of a grant that could never do anything: the skill is there and the Bot is not.
   * `plugin_grants.agent_id` names a Bot by id alone, since Bots live in Intelligence, so nothing in
   * the database stops a grant for a mistyped Bot id: the route asks Intelligence whether the Bot
   * exists, refuses with a sentence when it does not, and stores nothing.
   */
  test("a skill cannot be granted to a Bot nobody has", async () => {
    expect(
      (await writeSkill(asAdmin(), botlessSlug, "Triage by severity.", true))
        .status,
    ).toBe(200);

    const refused = await grant(asAdmin(), botlessSlug, missingBot);

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "There is no such Bot." });
    expect(
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, missingBot)),
    ).toEqual([]);
  });

  test("uninstalling removes that skill's grants and no other", async () => {
    const held = await database
      .select({ ref: pluginGrants.ref, agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          inArray(pluginGrants.agentId, [aliceBot, sharedBot]),
        ),
      );

    expect(held).toEqual([{ ref: keptSlug, agentId: aliceBot }]);
  });
});

afterAll(async () => {
  await database.$client.close();
});
