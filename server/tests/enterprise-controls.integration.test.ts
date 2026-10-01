import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent } from "@ag-ui/client";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono } from "hono";
import { EMPTY } from "rxjs";
import {
  type EnterpriseControls,
  guardDeliveryStore,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseGate } from "../src/admin/gate";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import { addAuditTap, createAuditStore, recordAuditEvent } from "../src/audit";
import { createAuth } from "../src/auth";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerProvider } from "../src/computer/provider";
import type { DeploymentConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  actionRecords,
  agentProfiles,
  agents,
  auditEvents,
  capabilitySettings,
  enterpriseSettings,
  modelUsage,
  networkPolicies,
  revokedAccess,
  scimGroups,
  sessions,
  ssoProviders,
  teamBotPublications,
  users,
} from "../src/db/schema";
import { createTurnRunner } from "../src/routines/run-turn";
import { createTeamBots } from "../src/team-bots/team-bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The enterprise controls against a real PostgreSQL, through the same seams production uses: the
 * stores, the LISTEN/NOTIFY snapshot, the HTTP gate, the in-place store guards, and SCIM through
 * Better Auth's own handler. Needs a database at the current TS schema (TEST_DATABASE_URL).
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const admin = {
  id: `ent-admin-${suite}`,
  email: `ent-admin-${suite}@acme.test`,
};
const member = {
  id: `ent-member-${suite}`,
  email: `ent-member-${suite}@acme.test`,
};
const bot = `ent-bot-${suite}`;
const stopped: string[] = [];
const provider: ComputerProvider = {
  name: "fake",
  isolation: "per-bot",
  locate: async () => "http://unused",
  status: async (botId) => ({ botId, state: "ready" }),
  stop: async (botId) => {
    stopped.push(botId);
    return { wasRunning: true };
  },
  reset: async () => ({ cleared: false }),
  list: async () => [
    {
      botId: bot,
      status: "running",
      url: "",
      startedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ],
};

let controls: EnterpriseControls;

async function clean() {
  await database.delete(capabilitySettings);
  await database.delete(enterpriseSettings);
  await database.delete(networkPolicies);
  await database
    .delete(actionRecords)
    .where(like(actionRecords.botId, `ent-bot-${suite}%`));
  await database
    .delete(modelUsage)
    .where(like(modelUsage.agentId, `ent-%${suite}%`));
}

beforeAll(async () => {
  await clean();
  await database.insert(users).values([
    { ...admin, name: "Admin" },
    { ...member, name: "Member", groups: ["sales"] },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: "Enterprise test Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: member.id,
    title: "Test",
    roleDescription: "Test",
    avatarSeed: "x",
    visibility: "private",
  });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    provider,
    builtInModel: "openai/gpt-test",
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await clean();
  await database.delete(agents).where(eq(agents.id, bot));
  await database
    .delete(revokedAccess)
    .where(like(revokedAccess.email, `%${suite}%`));
  await database
    .delete(scimGroups)
    .where(like(scimGroups.displayName, `%${suite}%`));
  await database.delete(users).where(like(users.email, `%${suite}%`));
  await database.$client.end({ timeout: 5 });
});

function appFor(actor: { id: string; email: string; role: "admin" | "user" }) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser = async (
    context: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    context.set("actor", actor);
    await next();
  };
  app.use("/api/*", createEnterpriseGate(requireUser));
  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));
  app.post("/api/delivery/slack/start", (context) =>
    context.json({ ok: true }),
  );
  app.patch("/api/agents/:id", (context) => context.json({ saved: true }));
  // Mounted the way app.ts mounts the CopilotKit runtime: a basePath sub-app that takes every path
  // under it. The runtime then matches a run by its TRAILING segments (fetch-router `matchSegments`:
  // `.../agent/<id>/run` anywhere under the base), so this stub answers whatever path reaches it.
  app.route(
    "/",
    new Hono()
      .basePath("/api/copilotkit")
      .all("*", (context) => context.json({ ran: true })),
  );
  return app;
}

const asAdmin = appFor({ ...admin, role: "admin" });
const asMember = appFor({ ...member, role: "user" });

const put = (
  app: Hono<{ Variables: AppVariables }>,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("capability switches", () => {
  test("only an administrator may change them, and the change is audited", async () => {
    expect(
      (
        await put(asMember, "/api/admin/enterprise/capabilities", {
          scopeKind: "organization",
          capability: "slackTeams",
          allowed: false,
        })
      ).status,
    ).toBe(403);
    const saved = await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability: "slackTeams",
      allowed: false,
    });
    expect(saved.status).toBe(200);
    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "capability.changed"),
          eq(auditEvents.actorUserId, admin.id),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
  });

  test("the HTTP gate refuses a member, and a group grant widens it", async () => {
    const refused = await asMember.request("/api/delivery/slack/start", {
      method: "POST",
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).capability).toBe("slackTeams");

    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "group",
      scopeId: "sales",
      capability: "slackTeams",
      allowed: true,
    });
    expect(
      (await asMember.request("/api/delivery/slack/start", { method: "POST" }))
        .status,
    ).toBe(200);
    const me = await (
      await asMember.request("/api/admin/enterprise/me")
    ).json();
    expect(me).toMatchObject({
      enforced: true,
      capabilities: { slackTeams: true },
    });
  });

  test("the store guard refuses a Slack link that never crosses the gate", async () => {
    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "group",
      scopeId: "sales",
      capability: "slackTeams",
      allowed: null,
    });
    const bound: string[] = [];
    const store = guardDeliveryStore(
      {
        bind: async (input: {
          ownerUserId: string;
          transport: string;
          realm: string;
          identity: string;
        }) => {
          bound.push(input.identity);
          return { id: randomUUID() };
        },
        removeBinding: async () => undefined,
      },
      auditStore,
      (message) => new Error(message),
    );
    await expect(
      store.bind({
        ownerUserId: member.id,
        transport: "slack",
        realm: "T1",
        identity: "U1",
      }),
    ).rejects.toThrow(/Slack and Teams/);
    await store.bind({
      ownerUserId: member.id,
      transport: "sms",
      realm: "+1",
      identity: "+1555",
    });
    expect(bound).toEqual(["+1555"]);
  });

  test("the snapshot follows NOTIFY, so the computer boundary sees a change at once", async () => {
    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability: "cloudBrowser",
      allowed: false,
    });
    const current = controls.snapshot();
    expect(
      current?.rows.some(
        (row) => row.capability === "cloudBrowser" && row.allowed === false,
      ),
    ).toBe(true);
  });
});

describe("models", () => {
  test("a built-in Bot on a model off the allowlist is refused and recorded", async () => {
    await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
      value: { enabled: true, models: ["anthropic/claude-test"] },
    });
    const refused = await asMember.request(`/api/copilotkit/agent/${bot}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t", runId: "r" }),
    });
    expect(refused.status).toBe(403);

    await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
      value: { enabled: true, models: ["openai/gpt-test"] },
    });
    const ran = await asMember.request(`/api/copilotkit/agent/${bot}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t", runId: "r2" }),
    });
    expect(ran.status).toBe(200);
    const usage = await database
      .select()
      .from(modelUsage)
      .where(eq(modelUsage.agentId, bot));
    expect(usage.map((row) => [row.model, row.allowed]).sort()).toEqual([
      ["openai/gpt-test", false],
      ["openai/gpt-test", true],
    ]);
    const summary = await (
      await asAdmin.request("/api/admin/enterprise/models/usage")
    ).json();
    expect(
      summary.summary.some(
        (row: { model: string }) => row.model === "openai/gpt-test",
      ),
    ).toBe(true);
  });
});

describe("the gate cannot be stepped around", () => {
  const setCapability = (capability: string, allowed: boolean) =>
    put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability,
      allowed,
    });

  test("a percent-encoded path is checked as the path the router serves", async () => {
    await setCapability("teamBots", false);
    try {
      const plain = await asMember.request(`/api/agents/${bot}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(plain.status).toBe(403);
      const encoded = await asMember.request(`/api/%61gents/${bot}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "public" }),
      });
      expect(encoded.status).toBe(403);
    } finally {
      await setCapability("teamBots", true);
    }
  });

  test("a run reached through extra leading segments is still a run", async () => {
    await setCapability("useBots", false);
    try {
      for (const path of [
        `/api/copilotkit/agent/${bot}/run`,
        `/api/copilotkit/x/agent/${bot}/run`,
        `/api/copilotkit/x/agent/${bot}/connect`,
        // Suggestions run the Bot's model too, with whatever messages the caller sends.
        `/api/copilotkit/agent/${bot}/suggest`,
        `/api/copilotkit/x/agent/${bot}/suggest`,
      ]) {
        const response = await asMember.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: "t", runId: `r-${path.length}` }),
        });
        expect([path, response.status]).toEqual([path, 403]);
      }
    } finally {
      await setCapability("useBots", true);
    }
  });

  test("the model allowlist also governs a run reached through extra segments", async () => {
    await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
      value: { enabled: true, models: ["anthropic/claude-test"] },
    });
    try {
      for (const action of ["run", "suggest"]) {
        const response = await asMember.request(
          `/api/copilotkit/x/agent/${bot}/${action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: "t", runId: `r-extra-${action}` }),
          },
        );
        expect([action, response.status]).toEqual([action, 403]);
      }
    } finally {
      await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
        value: { enabled: false, models: [] },
      });
    }
  });
});

class AnsweringAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/**
 * The shared headless turn runner behind routines, Run now, responsibilities, follow-ups, group
 * turns, delivery conversations and Slack/Teams/SMS inbound. None of those cross the HTTP gate.
 */
function headlessTurn(agentId: string) {
  const ran: string[] = [];
  const intelligence = {
    getOrCreateThread: async () => ({ thread: { id: "t" }, created: false }),
    getThreadMessages: async () => ({ messages: [] }),
    ɵacquireThreadLock: async (params: {
      threadId: string;
      runId: string;
    }) => ({
      threadId: params.threadId,
      runId: params.runId,
      joinToken: "j",
    }),
    ɵrenewThreadLock: async () => ({ ttlSeconds: 20 }),
    ɵcleanupThreadLock: async () => undefined,
  };
  const runner = {
    run: (request: { agent: AbstractAgent }) => ({
      subscribe(observer: { complete: () => void }) {
        ran.push(agentId);
        request.agent.messages = [
          ...request.agent.messages,
          { id: "a1", role: "assistant", content: "Done." },
        ] as typeof request.agent.messages;
        observer.complete();
        return { unsubscribe: () => undefined };
      },
    }),
    stop: async () => true,
  };
  const runTurn = createTurnRunner({
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    intelligence: intelligence as any,
    // biome-ignore lint/suspicious/noExplicitAny: narrow structural fakes, on purpose.
    runner: runner as any,
    buildAgentFor: async () => new AnsweringAgent({ agentId }),
  });
  return {
    ran,
    run: () =>
      runTurn({
        ownerUserId: member.id,
        routineId: "routine-1",
        agentId,
        threadId: `thread-${suite}`,
        instruction: "Say done.",
      }),
  };
}

describe("headless turns obey the same switches", () => {
  test("a member without Use Bots gets no unattended turn", async () => {
    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability: "useBots",
      allowed: false,
    });
    try {
      const turn = headlessTurn(bot);
      await expect(turn.run()).rejects.toThrow(/Use Bots|use Bots|Bots/);
      expect(turn.ran).toEqual([]);
    } finally {
      await put(asAdmin, "/api/admin/enterprise/capabilities", {
        scopeKind: "organization",
        capability: "useBots",
        allowed: true,
      });
    }
  });

  test("a built-in Bot on a model off the allowlist gets no unattended turn", async () => {
    await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
      value: { enabled: true, models: ["anthropic/claude-test"] },
    });
    try {
      const turn = headlessTurn(bot);
      await expect(turn.run()).rejects.toThrow(/allowlist/);
      expect(turn.ran).toEqual([]);
    } finally {
      await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
        value: { enabled: false, models: [] },
      });
    }
    const allowed = headlessTurn(bot);
    await expect(allowed.run()).resolves.toMatchObject({ replyText: "Done." });
  });

  test("a Bot-to-Bot hand-off meets the same switches", async () => {
    let ran = 0;
    const hop = createHandoffDelivery({
      deadlineMs: 5_000,
      agentFor: async () =>
        ({
          threadId: "",
          messages: [],
          setMessages() {},
        }) as unknown as AbstractAgent,
      history: async () => [],
      newRunId: () => `hop-${randomUUID()}`,
      mintThreadId: () => `hop-thread-${randomUUID()}`,
      lock: {
        acquire: async () => ({ runId: "platform-run" }),
        renew: async () => {},
        release: async () => {},
      },
      runner: {
        run: () => {
          ran += 1;
          return EMPTY;
        },
      },
    });
    const work = {
      fromBotId: "remote-bot",
      toBotId: bot,
      actorId: member.id,
      threadId: "thread",
      runId: "run",
      depth: 1,
      task: "check the numbers",
    };
    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability: "useBots",
      allowed: false,
    });
    try {
      await expect(
        hop.deliver({ work, message: "m", shown: "s", assertion: "a" }),
      ).rejects.toThrow(/Bots/);
    } finally {
      await put(asAdmin, "/api/admin/enterprise/capabilities", {
        scopeKind: "organization",
        capability: "useBots",
        allowed: true,
      });
    }
    await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
      value: { enabled: true, models: ["anthropic/claude-test"] },
    });
    try {
      await expect(
        hop.deliver({ work, message: "m", shown: "s", assertion: "a" }),
      ).rejects.toThrow(/allowlist/);
    } finally {
      await put(asAdmin, "/api/admin/enterprise/settings/modelAllowlist", {
        value: { enabled: false, models: [] },
      });
    }
    expect(ran).toBe(0);
  });
});

describe("Team Bots switch", () => {
  test("publishing to the team is refused while Team Bots is off", async () => {
    const teamBots = createTeamBots({
      database,
      connectedServers: async () => new Set<string>(),
    });
    await put(asAdmin, "/api/admin/enterprise/capabilities", {
      scopeKind: "organization",
      capability: "teamBots",
      allowed: false,
    });
    try {
      await expect(
        teamBots.publish({ id: member.id, role: "user" }, bot, {
          audience: "team",
          emails: [],
          groups: [],
        }),
      ).rejects.toThrow(/Team Bots/);
      const rows = await database
        .select()
        .from(teamBotPublications)
        .where(eq(teamBotPublications.agentId, bot));
      expect(rows).toEqual([]);
    } finally {
      await database
        .delete(teamBotPublications)
        .where(eq(teamBotPublications.agentId, bot));
      await put(asAdmin, "/api/admin/enterprise/capabilities", {
        scopeKind: "organization",
        capability: "teamBots",
        allowed: true,
      });
    }
  });
});

describe("SSO required", () => {
  test("turning it on through the admin route ends sessions made before it", async () => {
    const signedIn = {
      id: randomUUID(),
      userId: member.id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await database.insert(sessions).values(signedIn);
    const providerId = `ent-idp-${suite}`;
    try {
      // With nothing to sign in through, requiring SSO is refused rather than locking people out.
      const refused = await put(
        asAdmin,
        "/api/admin/enterprise/settings/ssoRequired",
        { value: true },
      );
      expect(refused.status).toBe(409);
      expect(
        await database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, signedIn.id)),
      ).toHaveLength(1);
      await database.insert(ssoProviders).values({
        id: providerId,
        issuer: "https://idp.acme.test",
        providerId,
        domain: "acme.test",
      });
      const response = await put(
        asAdmin,
        "/api/admin/enterprise/settings/ssoRequired",
        { value: true },
      );
      expect(response.status).toBe(200);
      expect(
        await database
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, signedIn.id)),
      ).toEqual([]);
      const [revoked] = await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "auth.sessions_revoked"),
            eq(auditEvents.actorUserId, admin.id),
          ),
        );
      expect(revoked?.payload).toMatchObject({ reason: "sso_required" });
    } finally {
      await database.delete(sessions).where(eq(sessions.id, signedIn.id));
      await put(asAdmin, "/api/admin/enterprise/settings/ssoRequired", {
        value: false,
      });
      await database
        .delete(ssoProviders)
        .where(eq(ssoProviders.id, providerId));
    }
  });
});

describe("network policy", () => {
  test("malformed rules are refused; a saved policy is audited and resolved per owner", async () => {
    expect(
      (
        await put(asAdmin, "/api/admin/enterprise/network", {
          scopeKind: "organization",
          mode: "allowlist_only",
          rules: [{ type: "domain", value: "not a domain" }],
        })
      ).status,
    ).toBe(400);
    await put(asAdmin, "/api/admin/enterprise/network", {
      scopeKind: "organization",
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "example.com" }],
    });
    await put(asAdmin, "/api/admin/enterprise/network", {
      scopeKind: "group",
      scopeId: "sales",
      mode: "defaults_plus_allowlist",
      rules: [{ type: "cidr", value: "10.0.0.0/8", ports: "443" }],
    });
    // The Bot's owner is in `sales`, so the group policy applies.
    expect(await controls.policyForBot(bot)).toEqual({
      mode: "defaults_plus_allowlist",
      rules: [{ type: "cidr", value: "10.0.0.0/8", ports: "443" }],
    });
  });
});

describe("offboarding", () => {
  test("terminating a member's computers stops their Bots and is audited", async () => {
    const response = await asAdmin.request(
      `/api/admin/enterprise/people/${member.id}/terminate-computers`,
      { method: "POST" },
    );
    expect((await response.json()).stopped).toEqual([bot]);
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "computer.terminated"),
          eq(auditEvents.targetId, member.id),
        ),
      );
    expect(row?.actorUserId).toBe(admin.id);
  });

  test("the inactive sweep stops a computer idle past the window", async () => {
    stopped.length = 0;
    const result = await controls.terminateInactiveComputers();
    expect(result?.stopped).toEqual([bot]);
  });
});

describe("action recording", () => {
  test("off records nothing; on records the command scrubbed", async () => {
    const write = (command: string) =>
      recordAuditEvent(auditStore, {
        eventType: "computer.action_allowed",
        targetType: "computer",
        targetId: bot,
        actorUserId: member.id,
        payload: { bot, action: "computer_run_command", command },
      });
    await write("echo off");
    await put(asAdmin, "/api/admin/enterprise/settings/actionRecording", {
      value: true,
    });
    await write("curl -H 'Authorization: Bearer s3cr3t' https://x.test");
    await Bun.sleep(100);
    const rows = await database
      .select()
      .from(actionRecords)
      .where(inArray(actionRecords.botId, [bot]));
    expect(rows.map((row) => row.command)).toEqual([
      "curl -H 'Authorization: Bearer [REDACTED]' https://x.test",
    ]);
  });
});

describe("OpenTelemetry export", () => {
  test("audit rows reach an OTLP/HTTP collector tagged with openbot.surface", async () => {
    const received: string[] = [];
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        received.push(
          `${new URL(request.url).pathname} ${await request.text()}`,
        );
        return new Response("{}");
      },
    });
    const { createOtelEventExporter } = await import("../src/telemetry/otel");
    const exporter = createOtelEventExporter({
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${collector.port}/v1/logs`,
    });
    expect(exporter).toBeDefined();
    const remove = addAuditTap((event) => exporter?.emit(event));
    await recordAuditEvent(auditStore, {
      eventType: "computer.action_refused",
      targetType: "computer",
      targetId: bot,
      payload: { bot, tool: "computer_navigate" },
    });
    remove();
    await exporter?.shutdown();
    collector.stop(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toContain("/v1/logs");
    expect(received.join("")).toContain("openbot.surface");
    expect(received.join("")).toContain("computer.action_refused");
  });
});

describe("SCIM 2.0 through Better Auth", () => {
  const token = `scim-${suite}-${randomUUID()}`;
  let auth: ReturnType<typeof createAuth>;
  const scimEmail = `ent-scim-${suite}@acme.test`;

  beforeAll(() => {
    process.env.SCIM_BEARER_TOKEN = token;
    auth = createAuth(
      {
        auth: {
          baseUrl: "http://127.0.0.1:3000",
          secret: "x".repeat(40),
          trustedOrigins: [],
          initialAdminEmails: [],
          allowedEmailDomains: [],
          google: { clientId: "id", clientSecret: "secret" },
        },
        keyEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      } as unknown as DeploymentConfig,
      database,
      async () => false,
      auditStore,
    );
  });
  afterAll(() => {
    delete process.env.SCIM_BEARER_TOKEN;
  });

  const scim = (method: string, path: string, body?: unknown, bearer = token) =>
    auth.handler(
      new Request(`http://127.0.0.1:3000/api/auth/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/scim+json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );

  test("a wrong token is refused", async () => {
    expect((await scim("GET", "/Users", undefined, "wrong")).status).toBe(401);
  });

  test("provision, group, deprovision, reprovision", async () => {
    const created = await scim("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: scimEmail,
      externalId: `ext-${suite}`,
      name: { givenName: "Scim", familyName: "Person" },
      emails: [{ value: scimEmail, primary: true, type: "work" }],
      active: true,
    });
    const createdBody = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    const [person] = await database
      .select()
      .from(users)
      .where(eq(users.email, scimEmail));
    expect(person).toBeDefined();

    const group = await scim("POST", "/Groups", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: `engineering-${suite}`,
      members: [{ value: createdBody.id }],
    });
    expect(group.status, await group.clone().text()).toBe(201);
    const [grouped] = await database
      .select()
      .from(users)
      .where(eq(users.email, scimEmail));
    expect(grouped?.groups).toEqual([`engineering-${suite}`]);

    const deactivated = await scim("PATCH", `/Users/${createdBody.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }],
    });
    expect(deactivated.status, await deactivated.clone().text()).toBe(200);
    const [denied] = await database
      .select()
      .from(revokedAccess)
      .where(eq(revokedAccess.email, scimEmail));
    expect(denied?.revokedBy).toBe("scim:directory");

    await scim("PATCH", `/Users/${createdBody.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    const after = await database
      .select()
      .from(revokedAccess)
      .where(eq(revokedAccess.email, scimEmail));
    expect(after).toEqual([]);
  });
});
