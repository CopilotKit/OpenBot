import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  skills,
  users,
} from "../src/db/schema";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const alice = `user_alice_${suite}`;
const bob = `user_bob_${suite}`;
const aliceBot = `agent_alice_${suite}`;
const sharedBot = `agent_shared_${suite}`;
const personalSlug = `standup-${suite}`;
const keptSlug = `kept-${suite}`;
const deploymentSlug = `triage-${suite}`;

beforeAll(async () => {
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
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "For a test.",
        avatarSeed: id,
        visibility: "private",
      })
      .onConflictDoNothing();
  }
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(inArray(skills.slug, [personalSlug, keptSlug, deploymentSlug]));
  await database
    .delete(agents)
    .where(inArray(agents.id, [aliceBot, sharedBot]));
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
