import { afterEach, expect, test } from "bun:test";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type { AgentProfile } from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import {
  createBot,
  deleteBot,
  getBot,
  listBots,
  updateBot,
} from "../src/lib/api/generated/bots/bots";
import {
  CreateBotResponse,
  GetBotResponse,
  ListBotsResponse,
  UpdateBotResponse,
} from "../src/lib/api/generated/bots/bots.zod";
import { idempotencyKey, ORGANIZATION_ID } from "../src/lib/api/request";
import { ClientError } from "../src/lib/client";

/**
 * api/openapi.yaml describes the Bots routes the server answers today, field for field.
 *
 * The real route handlers (`createAgentRoutes`, mounted at /api/agents in the server) behind the
 * generated client, through the table that sends each API operation to today's route. Every answer is
 * checked against the Zod schema generated from the spec, and every field the server sent must be
 * one the spec names: a field the server adds without the spec, or one the spec promises that the
 * server drops, fails here before any client is built on it.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const MANAGED = "http://managed.invalid/ag-ui";
const actor = { id: "person-1", email: "person@example.test", role: "user" };

function profile(overrides: Partial<AgentProfile> & { id: string }) {
  return {
    name: "Expense Review",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: overrides.id,
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: MANAGED,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    ...overrides,
  } satisfies AgentProfile;
}

/** Today's routes, on a store holding three kinds of Bot, answering the app's fetch. */
function today() {
  const rows: AgentProfile[] = [
    // One that comes with OpenBot, running inside it, isolated though this deployment can't.
    profile({
      id: "general-assistant",
      name: "General Assistant",
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
      endpoint: null,
      isolated: true,
      framework: "OpenBot",
    }),
    // A person's own, at its own address behind a key, with a callback credential.
    profile({
      id: "agent_own",
      endpoint: "https://agents.example.test/ag-ui",
      hasAuth: true,
      hasCallbackToken: true,
      framework: "LangChain",
      pinned: true,
    }),
    // The personal starter, whose instructions are kept apart from what it does.
    profile({ id: "starter", instructions: "Be brief.", assignedToMe: true }),
  ];
  const store: AgentProfileStore = {
    list: async (_actor, hidden) => rows.filter((row) => row.hidden === hidden),
    get: async (_actor, id) => rows.find((row) => row.id === id) ?? null,
    getWithin: async () => null,
    create: async (_actor, input) => {
      const created = profile({
        id: "agent_new",
        name: input.name,
        title: input.title,
        roleDescription: input.roleDescription,
        visibility: input.visibility,
      });
      rows.push(created);
      return created;
    },
    update: async (_actor, id, input) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("missing");
      Object.assign(row, {
        name: input.name,
        title: input.title,
        roleDescription: input.roleDescription,
        visibility: input.visibility,
      });
      return row;
    },
    duplicate: async () => {
      throw new Error("unexpected");
    },
    setHidden: async () => {},
    setPinned: async () => {},
    softDelete: async (_actor, id) => {
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      );
    },
    issueCallbackToken: async () => "unused",
    revokeCallbackToken: async () => {},
    agentForCallbackToken: async () => null,
  };
  const routes = createAgentRoutes(
    store,
    async (context, next) => {
      context.set("actor", actor as never);
      await next();
    },
    false,
    undefined,
    new Set(),
    undefined,
    true,
    MANAGED,
    undefined,
    { token: "managed-token", endpoints: [MANAGED] },
    { available: false },
  );
  const sent: string[] = [];
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const address = String(path);
      sent.push(`${init?.method ?? "GET"} ${address}`);
      // Today's server answers at /api/agents and nowhere else; the API's address is not served yet.
      if (!address.startsWith("/api/agents"))
        return new Response(null, { status: 404 });
      expect(init?.credentials).toBe("include");
      return routes.request(
        new Request(
          `http://server.invalid${address.slice("/api/agents".length) || "/"}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return { sent };
}

/** Every key a Bot carries is one the spec's Bot names. */
function onlySpecFields(bot: object, schema: { shape: object }) {
  const named = Object.keys(schema.shape);
  expect(Object.keys(bot).filter((key) => !named.includes(key))).toEqual([]);
}
const BOT_SCHEMA = GetBotResponse.shape.bot;

test("every Bot today's server lists matches the spec's Bot, and nothing more", async () => {
  const { sent } = today();
  const page = await listBots(ORGANIZATION_ID, { limit: 100 });

  expect(ListBotsResponse.parse(page)).toEqual(page);
  expect(page.nextCursor).toBeNull();
  expect(page.bots.map((bot) => bot.id)).toEqual([
    "general-assistant",
    "agent_own",
    "starter",
  ]);
  for (const bot of page.bots) onlySpecFields(bot, BOT_SCHEMA);
  // The verdicts the screens render come through as the server decided them.
  const [builtIn, own, starter] = page.bots;
  expect(builtIn).toMatchObject({
    canManage: false,
    mine: false,
    runsOnOpenBotModel: true,
    isolationActive: false,
    isolationOffReason: "deployment",
  });
  expect(own).toMatchObject({ canManage: true, mine: true, builtIn: false });
  expect(starter).toMatchObject({
    instructions: "Be brief.",
    builtIn: true,
    keyFromOpenBot: true,
    assignedToMe: true,
  });
  expect(sent).toEqual(["GET /api/agents"]);
});

test("one Bot, a new one, a changed one and a deleted one all match the spec", async () => {
  const { sent } = today();
  const key = () => ({ "Idempotency-Key": idempotencyKey() });

  const read = await getBot(ORGANIZATION_ID, "agent_own");
  expect(GetBotResponse.parse(read)).toEqual(read);
  onlySpecFields(read.bot, BOT_SCHEMA);

  const created = await createBot(
    ORGANIZATION_ID,
    {
      name: "Expense Review",
      title: "",
      roleDescription: "Review receipts.",
      visibility: "private",
    },
    key(),
  );
  expect(CreateBotResponse.parse(created)).toEqual(created);
  onlySpecFields(created.bot, BOT_SCHEMA);

  // Made public: today's server reports what that means for the shared app accounts it uses.
  const changed = await updateBot(
    ORGANIZATION_ID,
    "agent_new",
    {
      name: "Expense Review Desk",
      title: "",
      roleDescription: "Review receipts.",
      visibility: "public",
    },
    key(),
  );
  expect(UpdateBotResponse.parse(changed)).toEqual(changed);
  expect(changed.bot.name).toBe("Expense Review Desk");
  expect(changed.sharedApps).toEqual({ approved: [], needsApproval: [] });

  expect(await deleteBot(ORGANIZATION_ID, "agent_new", key())).toBeUndefined();

  expect(sent).toEqual([
    "GET /api/agents/agent_own",
    "POST /api/agents",
    "PATCH /api/agents/agent_new",
    "DELETE /api/agents/agent_new",
  ]);
});

test("a refusal reaches the caller as today: the server's own sentence, its status", async () => {
  today();
  const refused = await getBot(ORGANIZATION_ID, "nobody", {
    fallback: "Couldn't load this Bot.",
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ClientError);
  expect((refused as ClientError).message).toBe("Couldn't find that Bot.");
  expect((refused as ClientError).status).toBe(404);
});
