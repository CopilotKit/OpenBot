import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Making a Bot with your own instructions on a deployment with no Bot in the box.
 *
 * OpenBot Desktop's personal edition writes `MANAGED_AGENT_AG_UI_URL` empty: its Personal Assistant
 * runs inside the server. The New Bot sheet asks `/api/agents/capabilities` whether a Bot can run
 * here, and the answer was "is there a managed Bot", so on the Desktop it said no. The sheet then
 * printed "An admin must enable built-in hosting before you can run a Bot here." to the only person,
 * who is the admin, and sent them to "Connect a custom agent": nobody could make a Bot that follows
 * their instructions. The server has created such a Bot all along (a `built_in` row running on the
 * role description), so the capability was answering the wrong question.
 *
 * Through `createApp` with the configuration the Desktop writes, against a real PostgreSQL, so the
 * wiring in app.ts is what is tested and not a value this file passes in.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** Bots this file made, removed after; the single person is shared with other suites and stays. */
const made: string[] = [];

const config = loadConfig(
  testEnvironment({
    DATABASE_URL: testDatabaseUrl(),
    // As OpenBot Desktop writes it: the personal edition, with no Bot in the box.
    OPENBOT_EDITION: "personal",
    GOOGLE_OAUTH_CLIENT_ID: undefined,
    GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    BETTER_AUTH_SECRET: undefined,
    BETTER_AUTH_URL: undefined,
    INITIAL_ADMIN_EMAILS: undefined,
    OPENBOT_SINGLE_USER: "true",
    AGENT_COMPUTER_URL: "http://127.0.0.1:4100",
    MANAGED_AGENT_AG_UI_URL: "",
  }),
);

// Single-user, as on the Desktop: every request from this machine is the one person.
const app = createApp(
  config,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  createAgentProfileStore(database, config.managedAgent?.endpoint),
);

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: DEV_ACTOR.id, email: DEV_ACTOR.email, name: "Person" })
    .onConflictDoNothing();
});

afterAll(async () => {
  for (const id of made) {
    await database.delete(agents).where(eq(agents.id, id));
  }
  await database.$client.end({ timeout: 5 });
});

test("the deployment has no Bot in the box", () => {
  expect(config.managedAgent).toBeUndefined();
});

test("the New Bot sheet is told a Bot can run here", async () => {
  const response = await app.request(
    "http://openbot.test/api/agents/capabilities",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    capabilities: { builtInAvailable: boolean };
  };
  expect(body.capabilities.builtInAvailable).toBe(true);
});

test("a Bot made with no address runs here, on the person's instructions", async () => {
  const instructions =
    "Always answer in exactly three bullet points and end with the word DONE.";
  // What the sheet sends for a Bot that runs here: no endpoint, the instructions as its role.
  const response = await app.request("http://openbot.test/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Triple Bullet",
      title: "",
      roleDescription: instructions,
      visibility: "private",
      endpoint: "",
    }),
  });
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as { agent: { id: string } };
  made.push(agent.id);
  const [row] = await database
    .select({ type: agents.type, configuration: agents.configuration })
    .from(agents)
    .where(eq(agents.id, agent.id));
  expect(row).toEqual({
    type: "built_in",
    configuration: { systemPrompt: instructions },
  });
});
