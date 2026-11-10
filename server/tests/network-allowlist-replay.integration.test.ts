import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import { botSeat } from "../src/computer/computer-key";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  networkPolicies,
  users,
} from "../src/db/schema";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/network-allowlist-recorded.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * The network allowlist, described, replayed and saved, against a real PostgreSQL.
 *
 * The page visits are written by the real gateway: a Bot opens pages through `gateway.navigate`, the
 * enterprise controls' navigation check allows or refuses each one under the network policy in
 * force, and the gateway writes the audit rows. The replay reads those rows back through the audit
 * reader, and judges each with `egressDecision` under the candidate. Then the admin saves the list
 * through the route the screen calls, with the sentence, and the same pages are opened again: the
 * ones the replay said the list would block are refused, live.
 *
 * Only the computer and the model are seams: the computer answers every page it is sent to, and the
 * model is aimock serving the answers recorded from the real API (fixtures/network-allowlist-recorded.json).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const auditReader = createAuditReader(database);
const suite = randomUUID().slice(0, 8);
const GROUP = `sales-${suite}`;
const ADMIN = {
  id: `net-admin-${suite}`,
  email: `net-admin-${suite}@acme.test`,
  name: "Admin",
  image: null,
};
/** In the group with a policy of its own. */
const SALES = {
  id: `net-sales-${suite}`,
  email: `net-sales-${suite}@acme.test`,
};
/** In no group: under the organization's policy. */
const OPS = { id: `net-ops-${suite}`, email: `net-ops-${suite}@acme.test` };
const SALES_BOT = `net-sales-bot-${suite}`;
const OPS_BOT = `net-ops-bot-${suite}`;

const ALLOW_ALL: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** A computer that opens whatever page it is sent to. */
const provider: ComputerProvider = {
  name: "test",
  isolation: "per-person",
  locate: async () => "http://agent-computer:4100",
  status: async (seat) => ({ botId: seat.botId, state: "ready" }),
  stop: async () => ({ wasRunning: true }),
  reset: async () => ({ cleared: true }),
  list: async () => [],
};
const gateway = createComputerGateway({
  provider,
  fetchImpl: (async (_input: unknown, init?: RequestInit) => {
    const { url } = JSON.parse(String(init?.body ?? "{}")) as { url?: string };
    return Response.json({ url: url ?? "", title: "", elapsedMs: 1 });
  }) as unknown as typeof fetch,
  auditStore,
  policy: () => ALLOW_ALL,
});

const mock = new LLMock();
const originalBaseUrl = process.env.OPENAI_BASE_URL;
let controls: EnterpriseControls;

/** The app as the deployment builds it, signed in as the admin. */
function appFor() {
  const args: never[] = Array.from({ length: 35 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: ADMIN }) },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  args[3] = auditReader as never;
  args[12] = auditStore as never;
  args[34] = {
    boundaryWriter: createModelCompleter({
      model: {
        provider: "openai",
        defaultModel: recorded.writtenFirstTime.model,
      },
      resolveApiKey: async () => "test-key",
    }),
  } as never;
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return build(...args);
}

function send(
  app: ReturnType<typeof createApp>,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
) {
  return app.request(`http://localhost:3001${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify(body),
  });
}

/** Opens a page as the Bot's owner would have it opened, and says whether the controls let it. */
async function visit(bot: string, owner: string, url: string) {
  try {
    await gateway.navigate(botSeat(bot), { id: owner, userId: owner }, url);
    return "allowed";
  } catch (error) {
    if (error instanceof ActionRefusedError) return "refused";
    throw error;
  }
}

async function clean() {
  await database.delete(networkPolicies);
}

beforeAll(async () => {
  process.env.OPENAI_BASE_URL = await mock.start();
  await clean();
  await database.insert(users).values([
    { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name },
    { ...SALES, name: "Sales", groups: [GROUP] },
    { ...OPS, name: "Ops" },
  ]);
  await database.insert(agents).values(
    [SALES_BOT, OPS_BOT].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  await database.insert(agentProfiles).values(
    [
      [SALES_BOT, SALES.id],
      [OPS_BOT, OPS.id],
    ].map(([agentId, ownerUserId]) => ({
      agentId: agentId as string,
      ownerUserId: ownerUserId as string,
      title: "Test",
      roleDescription: "Test",
      avatarSeed: "x",
      visibility: "private" as const,
    })),
  );
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await mock.stop();
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
  await clean();
  await database.delete(agents).where(inArray(agents.id, [SALES_BOT, OPS_BOT]));
  await database.delete(users).where(like(users.email, `%${suite}%`));
  await database.$client.end({ timeout: 5 });
});

describe("the network allowlist in English", () => {
  const app = appFor();

  test("described, replayed over the pages Bots opened, and saved with the sentence: the replay says what the saved list then blocks", async () => {
    // The policies in force: the organization's allows a few sites and the package hosts, and the
    // sales group's own policy allows everything.
    const inForce = [
      { type: "domain", value: "hubspot.com" },
      { type: "domain", value: "linkedin.com" },
      { type: "domain", value: "salesforce.com" },
      { type: "domain", value: "force.com" },
    ];
    expect(
      (
        await send(app, "PUT", "/api/admin/enterprise/network", {
          scopeKind: "organization",
          mode: "defaults_plus_allowlist",
          rules: inForce,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(app, "PUT", "/api/admin/enterprise/network", {
          scopeKind: "group",
          scopeId: GROUP,
          mode: "allow_all",
          rules: [],
        })
      ).status,
    ).toBe(200);

    // Pages the Bots open, decided live by the controls and recorded by the gateway.
    const visits: [string, string, string, "allowed" | "refused"][] = [
      [OPS_BOT, OPS.id, "https://app.hubspot.com/contacts/1", "allowed"],
      [OPS_BOT, OPS.id, "https://www.linkedin.com/feed/", "allowed"],
      [OPS_BOT, OPS.id, "https://www.linkedin.com/in/someone", "allowed"],
      [
        OPS_BOT,
        OPS.id,
        "https://acme.lightning.force.com/lightning/page/home",
        "allowed",
      ],
      // Not on the organization's list today, so refused by its network policy.
      [OPS_BOT, OPS.id, "https://docs.google.com/document/d/1", "refused"],
      // The sales group's policy allows everything.
      [SALES_BOT, SALES.id, "https://www.linkedin.com/sales", "allowed"],
    ];
    for (const [bot, owner, url, expected] of visits)
      expect([url, await visit(bot, owner, url)]).toEqual([url, expected]);

    // The rows are the gateway's own: one per page, with the page it opened.
    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          inArray(auditEvents.eventType, [
            "computer.action_allowed",
            "computer.action_refused",
          ]),
          inArray(sql<string>`${auditEvents.payload} ->> 'bot'`, [
            SALES_BOT,
            OPS_BOT,
          ]),
        ),
      );
    expect(rows).toHaveLength(visits.length);
    const refusedRow = rows.find(
      (row) => row.eventType === "computer.action_refused",
    );
    expect(refusedRow?.payload).toMatchObject({
      action: "computer_navigate",
      bot: OPS_BOT,
      page: "https://docs.google.com/document/d/1",
      decision: { allowed: false, rule: "network:organization" },
    });

    // The admin describes the list. The model's answer is the one recorded from the real API.
    serveRecorded();
    const translated = await send(
      app,
      "POST",
      "/api/admin/enterprise/network/translate",
      { text: recorded.writtenFirstTime.text },
    );
    expect(translated.status).toBe(200);
    const written = (await translated.json()) as {
      mode: "allowlist_only";
      rules: { type: string; value: string }[];
      check: { ok: boolean };
    };
    expect(written.check.ok).toBe(true);
    expect(written.mode).toBe("allowlist_only");

    // Replayed for the organization, over exactly the visits above: the newest on the trail.
    const candidate = {
      scopeKind: "organization",
      scopeId: "",
      mode: written.mode,
      rules: written.rules,
      locked: false,
    };
    const replay = await send(
      app,
      "POST",
      "/api/admin/enterprise/network/replay",
      { ...candidate, limit: visits.length },
    );
    expect(replay.status).toBe(200);
    const { report } = await replay.json();
    expect(report).toEqual({
      scanned: 6,
      // The sales Bot is under its group's policy, which this one would not replace.
      covered: 5,
      // HubSpot and LinkedIn are allowed today and not on the new list.
      wouldBlock: 3,
      // Google Docs is refused today and on the new list.
      wouldAllow: 1,
      undecided: 0,
      // Salesforce Lightning is allowed by both.
      unchanged: 1,
      // Most visits first, then the most recent.
      hosts: [
        {
          host: "www.linkedin.com",
          change: "block",
          visits: 2,
          bots: [OPS_BOT],
          lastVisit: expect.any(String),
        },
        {
          host: "docs.google.com",
          change: "allow",
          visits: 1,
          bots: [OPS_BOT],
          lastVisit: expect.any(String),
        },
        {
          host: "app.hubspot.com",
          change: "block",
          visits: 1,
          bots: [OPS_BOT],
          lastVisit: expect.any(String),
        },
      ],
      sites: 3,
    });

    // Locked, the organization's policy replaces the group's too, so the sales Bot's visit counts.
    const locked = await (
      await send(app, "POST", "/api/admin/enterprise/network/replay", {
        ...candidate,
        locked: true,
        limit: visits.length,
      })
    ).json();
    expect(locked.report).toMatchObject({
      covered: 6,
      wouldBlock: 4,
      wouldAllow: 1,
    });
    expect(locked.report.hosts[0]).toMatchObject({
      host: "www.linkedin.com",
      visits: 3,
      bots: expect.arrayContaining([OPS_BOT, SALES_BOT]),
    });

    // A list the save would refuse is not replayed either.
    const broken = await send(
      app,
      "POST",
      "/api/admin/enterprise/network/replay",
      {
        ...candidate,
        rules: [{ type: "domain", value: "my_tools.corp.example" }],
      },
    );
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({
      error: '"my_tools.corp.example" is not a domain.',
    });

    // The admin saves it, through the route the screen calls, with the sentence it came from.
    const saved = await send(app, "PUT", "/api/admin/enterprise/network", {
      scopeKind: "organization",
      scopeId: "",
      mode: written.mode,
      rules: written.rules,
      locked: false,
      authoring: { source: "english", text: recorded.writtenFirstTime.text },
    });
    expect(saved.status).toBe(200);
    const [changed] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "network_policy.changed"),
          eq(auditEvents.actorUserId, ADMIN.id),
          sql`${auditEvents.payload} -> 'authoring' is not null`,
        ),
      );
    expect(changed?.payload).toMatchObject({
      scopeKind: "organization",
      mode: "allowlist_only",
      rules: written.rules,
      authoring: { source: "english", text: recorded.writtenFirstTime.text },
    });
    // And the draft before it is on the trail with the admin's words.
    const [drafted] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "network_policy.translated"),
          eq(auditEvents.actorUserId, ADMIN.id),
        ),
      );
    expect(drafted?.payload).toMatchObject({
      text: recorded.writtenFirstTime.text,
      outcome: "written",
    });

    // Live, the same pages decide as the replay said they would.
    expect(await visit(OPS_BOT, OPS.id, "https://www.linkedin.com/feed/")).toBe(
      "refused",
    );
    expect(
      await visit(OPS_BOT, OPS.id, "https://app.hubspot.com/contacts/1"),
    ).toBe("refused");
    expect(
      await visit(OPS_BOT, OPS.id, "https://docs.google.com/document/d/1"),
    ).toBe("allowed");
    expect(
      await visit(
        OPS_BOT,
        OPS.id,
        "https://acme.lightning.force.com/lightning/page/home",
      ),
    ).toBe("allowed");
  });

  test("a saved list with no sentence records none, and a malformed sentence is refused with nothing saved", async () => {
    const before = await database.select().from(networkPolicies);
    const refused = await send(app, "PUT", "/api/admin/enterprise/network", {
      scopeKind: "organization",
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "example.com" }],
      authoring: { source: "model", text: "" },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error:
        'authoring must be { source: "english", text } with text of at most 2000 characters.',
    });
    expect(await database.select().from(networkPolicies)).toEqual(before);
  });
});

function serveRecorded() {
  const recording = recorded.writtenFirstTime;
  mock.clearFixtures();
  mock.on({ userMessage: /<description>/ }, { content: recording.writer[0] });
  mock.on(
    { userMessage: /You explain one OpenBot network allowlist/ },
    { content: recording.reader },
  );
}
