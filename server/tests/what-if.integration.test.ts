import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import type {
  WhatIfAction,
  WhatIfLayer,
  WhatIfResult,
} from "@openbot/shared/what-if";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  decideFromSnapshot,
  type EnterpriseSnapshot,
  loadEnterpriseSnapshot,
} from "../src/admin/controls";
import { createEnterpriseStore } from "../src/admin/settings-store";
import { createApp } from "../src/app";
import { createApprovalStore } from "../src/approvals/store";
import type { ApprovalPolicyStore } from "../src/approvals/types";
import { type AuditEventInput, createAuditStore } from "../src/audit";
import { personSeat } from "../src/computer/computer-key";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { setPolicyOverlay } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { approvalRules, auditEvents } from "../src/db/schema";
import { PluginRefusedError } from "../src/plugins/plugin-store/model";
import { createPluginStore } from "../src/plugins/store";
import { createModelCompleter } from "../src/routing/model";
import { readAuditEvent, readWhatIfVocabulary } from "../src/what-if";
import type { GovernanceReaders } from "../src/what-if-check";
import recorded from "./fixtures/what-if-recorded.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import {
  ADMIN,
  CASEY,
  CRM,
  clearWhatIf,
  GMAIL,
  NO_SOCIAL,
  NO_UNATTENDED_EMAIL,
  ownVocabulary,
  POLICY,
  RESEARCH_BOT,
  SALES_BOT,
  SAM,
  seedWhatIf,
} from "./support/what-if-deployment";

/**
 * "What would happen if…": an admin's question read as one action by the deployment's model, checked
 * against this OpenBot, confirmed, and then put to the real deciders in the order the product asks
 * them. And "Why did this happen?": the same check about an audit row the real paths wrote.
 *
 * Through the real routes in `createApp`, against a real PostgreSQL holding a real boundary, real app
 * grants, real permissions, a real app allowlist, a real network allowlist and a real team approval
 * rule, all written through the stores the admin screens write through
 * (`support/what-if-deployment.ts`). The model is answered by aimock serving answers recorded from the
 * real API to these exact prompts (`fixtures/what-if-recorded.json`). The rows "Why did this happen?"
 * is asked about are written by the real plugin store's `callTool` and the real computer gateway.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const trail = createAuditStore(database);
const policyStore = createPolicyStore(POLICY);
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: trail,
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => policyStore.get(),
  callVendor: async () => ({ text: "done", isError: false }),
});
const approvals = createApprovalStore(database);
let snapshot: EnterpriseSnapshot | undefined;
const readers: GovernanceReaders = {
  policy: () => policyStore.get(),
  enterprise: () => ({ snapshot }),
  grant: (ref, botId) => plugins.decide("mcp", ref, botId),
  approvals: {
    policy: approvals.policy as ApprovalPolicyStore,
    rules: (owner) => approvals.rules(owner),
  },
};

/** A computer that answers whatever it is asked. Every action here is refused before it. */
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
  fetchImpl: (async () =>
    Response.json({
      url: "",
      title: "",
      elapsedMs: 1,
    })) as unknown as typeof fetch,
  auditStore: trail,
  policy: () => policyStore.get(),
});

const mock = new LLMock();
const originalBaseUrl = process.env.OPENAI_BASE_URL;
let startedAt: Date;

beforeAll(async () => {
  await seedWhatIf(database);
  snapshot = await loadEnterpriseSnapshot(createEnterpriseStore(database));
  // The enterprise controls as `installEnterpriseControls` installs them, on this OpenBot's settings,
  // so the real `callTool` and the real gateway decide the rows below as a running server would.
  setPolicyOverlay((context) => decideFromSnapshot(snapshot, context));
  process.env.OPENAI_BASE_URL = await mock.start();
  const [now] = (await database.execute(
    sql`select now() as now`,
  )) as unknown as {
    now: Date;
  }[];
  startedAt = new Date((now as { now: Date }).now);
});

afterEach(() => {
  mock.clearFixtures();
  mock.clearRequests();
});

afterAll(async () => {
  setPolicyOverlay(null);
  await clearWhatIf(database);
  await mock.stop();
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
  await database.$client.close();
});

type Case = { model: string; text: string; writer: string[] };

/** The model's attempts in order, each matched by what only its prompt carries. */
function serve(recording: Case) {
  const [first, second] = recording.writer;
  if (second)
    mock.on({ userMessage: /What was wrong with it:/ }, { content: second });
  if (first) mock.on({ userMessage: /<question>/ }, { content: first });
}

function appFor(options: {
  model?: string;
  key?: string | null;
  role?: "admin" | "user";
}) {
  const audit: AuditEventInput[] = [];
  const args: never[] = Array.from({ length: 35 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({ user: { ...ADMIN, image: null } }),
    },
  } as never;
  args[2] = { rolesForUser: async () => [options.role ?? "admin"] } as never;
  args[12] = {
    insert: async (event: AuditEventInput) => {
      audit.push(event);
    },
  } as never;
  args[34] = {
    whatIf: {
      complete: createModelCompleter({
        model: {
          provider: "openai",
          defaultModel: options.model ?? "gpt-5.6-terra",
        },
        resolveApiKey: async () =>
          options.key === undefined ? "test-key" : options.key,
      }),
      // The real reader, narrowed to this file's OpenBot so the prompt is the one recorded.
      vocabulary: async () =>
        ownVocabulary(await readWhatIfVocabulary(database)),
      readers,
      event: (id: string) => readAuditEvent(database, id),
    },
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return { app: build(...args), audit };
}

const BASE = "http://localhost:3001/api/admin/what-if";
const json = (body: unknown) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "http://localhost:3001",
  },
  body: JSON.stringify(body),
});

async function askOf(app: ReturnType<typeof createApp>, question: string) {
  return app.request(`${BASE}/ask`, json({ question }));
}

async function checkOf(
  app: ReturnType<typeof createApp>,
  action: WhatIfAction,
  question?: string,
): Promise<{
  status: number;
  body: { result: WhatIfResult } & Record<string, unknown>;
}> {
  const response = await app.request(
    `${BASE}/check`,
    json({ action, ...(question ? { question } : {}) }),
  );
  return { status: response.status, body: await response.json() };
}

/** Each control's id and verdict, in order, and which one decides and which are never reached. */
function verdicts(result: WhatIfResult) {
  return result.layers.map((layer) => [
    layer.id,
    layer.verdict,
    layer.decides ? "decides" : layer.unreached ? "unreached" : "",
  ]);
}

function layerOf(result: WhatIfResult, id: WhatIfLayer["id"]): WhatIfLayer {
  const found = result.layers.find((layer) => layer.id === id);
  if (!found) throw new Error(`no ${id} layer`);
  return found;
}

const action = (overrides: Partial<WhatIfAction>): WhatIfAction => ({
  bot: SALES_BOT.id,
  person: SAM.id,
  group: "",
  initiator: "person",
  surface: "app",
  app: GMAIL,
  tool: "send_email",
  intent: "",
  host: "",
  label: "",
  command: "",
  file: "",
  ...overrides,
});

/** The prompt each model request carried, in order. */
function prompts(): string[] {
  return mock.getRequests().map((entry) => {
    const messages = (entry.body as { messages?: { content?: unknown }[] })
      ?.messages;
    return String(messages?.at(-1)?.content ?? "");
  });
}

describe("asking what would happen", () => {
  test("a routine sending email from the Sales Bot is read as that action, and the boundary that names it refuses it", async () => {
    const recording = recorded.routineEmail;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const asked = await askOf(app, recording.text);
    expect(asked.status).toBe(200);
    const parsed = await asked.json();
    // Nobody named, so the run is on the Bot's owner, as a routine's always is.
    expect(parsed).toEqual({
      understood: "yes",
      action: action({ initiator: "routine" }),
      labels: { bot: "Sales", person: "Sam Lee", app: "Gmail" },
      missing: null,
    });
    // Parsed with structured output, held to the action's own schema.
    expect(
      (mock.getRequests()[0]?.body as { response_format?: unknown } | undefined)
        ?.response_format,
    ).toMatchObject({
      type: "json_schema",
      json_schema: { name: "what_if_action", strict: true },
    });
    expect(prompts()[0]).toContain(
      `${GMAIL}: Gmail: delete_email, list_emails, send_email`,
    );

    const { status, body } = await checkOf(app, parsed.action, recording.text);
    expect(status).toBe(200);
    const result = body.result;
    expect(result.outcome).toBe("refused");
    expect(result.decidedBy).toBe("boundaries");
    expect(result.effect).toBe("write");
    expect(verdicts(result)).toEqual([
      ["grant", "allows", ""],
      ["app_allowlist", "allows", ""],
      ["capabilities", "allows", ""],
      ["boundaries", "refuses", "decides"],
      ["safety", "asks", "unreached"],
      ["approvals", "allows", "unreached"],
    ]);
    expect(layerOf(result, "boundaries")).toMatchObject({
      basis: "No email when nobody is watching",
      rule: NO_UNATTENDED_EMAIL,
      summary: 'The rule "No email when nobody is watching" refuses it.',
    });
    expect(layerOf(result, "grant").summary).toBe(
      'The Sales Bot has been given "Send email" on Gmail.',
    );
    expect(layerOf(result, "app_allowlist").summary).toBe(
      "Gmail is on the approved list.",
    );
    expect(result.headline).toBe("Refused. Boundaries decide it.");
    expect(result.notApplicable).toEqual(["Network allowlist"]);

    // The question, and the check, each on the trail.
    expect(audit.map((event) => [event.eventType, event.payload])).toEqual([
      [
        "what_if.asked",
        {
          actor: ADMIN.email,
          question: recording.text,
          outcome: "parsed",
          action: parsed.action,
          attempts: 1,
        },
      ],
      [
        "what_if.checked",
        {
          actor: ADMIN.email,
          from: "question",
          question: recording.text,
          action: parsed.action,
          outcome: "refused",
          decidedBy: "boundaries",
        },
      ],
    ]);
  });

  test("the same email sent while Sam is chatting passes the boundary, and the safety floor asks Sam first", async () => {
    const recording = recorded.chatEmail;
    serve(recording);
    const { app } = appFor({ model: recording.model });

    const parsed = await (await askOf(app, recording.text)).json();
    expect(parsed.action).toEqual(action({}));
    const { body } = await checkOf(app, parsed.action);
    expect(body.result.outcome).toBe("asks");
    expect(verdicts(body.result)).toEqual([
      ["grant", "allows", ""],
      ["app_allowlist", "allows", ""],
      ["capabilities", "allows", ""],
      ["boundaries", "allows", ""],
      ["safety", "asks", "decides"],
      ["approvals", "allows", "unreached"],
    ]);
    expect(layerOf(body.result, "boundaries").basis).toBe("Everything else");
    expect(layerOf(body.result, "safety").summary).toBe(
      "Built in: sending something to other people asks the person first. They can allow it once, for the conversation, or always.",
    );
  });

  test("opening LinkedIn from the Research Bot is refused by its boundary, after the permissions and the network let it through", async () => {
    const recording = recorded.openLinkedIn;
    serve(recording);
    const { app } = appFor({ model: recording.model });

    const parsed = await (await askOf(app, recording.text)).json();
    expect(parsed.action).toEqual(
      action({
        bot: RESEARCH_BOT.id,
        person: CASEY.id,
        surface: "computer",
        app: "",
        tool: "",
        intent: "navigate",
        host: "linkedin.com",
      }),
    );
    const { body } = await checkOf(app, parsed.action);
    expect(verdicts(body.result)).toEqual([
      ["capabilities", "allows", ""],
      ["network", "allows", ""],
      ["boundaries", "refuses", "decides"],
      ["safety", "allows", "unreached"],
      ["approvals", "allows", "unreached"],
    ]);
    expect(layerOf(body.result, "capabilities").summary).toBe(
      '"Use Bots", "Cloud browser use" and "Cloud network access" are on for Casey Moore.',
    );
    expect(layerOf(body.result, "boundaries")).toMatchObject({
      basis: "No social media",
      rule: NO_SOCIAL,
    });
    expect(body.result.notApplicable).toEqual(["App grants", "App allowlist"]);
  });

  test("a question about something that already happened is not read as an action, and says where to look", async () => {
    const recording = recorded.unclear;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await askOf(app, recording.text);
    expect(response.status).toBe(200);
    const unclear = JSON.parse(recording.writer[0] as string).unclear;
    expect(await response.json()).toEqual({ understood: "no", unclear });
    expect(unclear).toContain("Audit");
    expect(audit[0]?.payload).toMatchObject({
      outcome: "unclear",
      attempts: 1,
    });
  });

  test("an action that fails the check goes back once with what was wrong, and the corrected one is checked against the team's approval rule", async () => {
    const recording = recorded.fixedOnRetry;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const parsed = await (await askOf(app, recording.text)).json();
    // The first answer was a page read with no page. Told so, the model named Gmail's list_emails.
    const sent = prompts();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(recording.writer[0] as string);
    expect(sent[1]).toContain('"read" happens on a web page');
    expect(parsed.action).toEqual(action({ tool: "list_emails" }));
    expect(audit[0]?.payload).toMatchObject({ outcome: "parsed", attempts: 2 });

    const { body } = await checkOf(app, parsed.action);
    expect(body.result.effect).toBe("read");
    expect(verdicts(body.result)).toEqual([
      ["grant", "allows", ""],
      ["app_allowlist", "allows", ""],
      ["capabilities", "allows", ""],
      ["boundaries", "allows", ""],
      ["safety", "allows", ""],
      ["approvals", "asks", "decides"],
    ]);
    expect(layerOf(body.result, "approvals")).toMatchObject({
      summary: "A team rule asks the person first.",
      basis: '"List emails" on Gmail, any Bot',
    });
  });

  test("an action that fails the check twice is refused, never guessed at, and the problems are recorded", async () => {
    const recording = recorded.failsTwice;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await askOf(app, recording.text);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "Couldn't turn that into one action. Ask it another way, or set the action yourself.",
    });
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "not_valid",
      attempts: 2,
      problems: [
        expect.stringContaining(
          'understood is "no", but the answer names an action',
        ),
      ],
    });
  });

  test("with no model set up it says one is needed, asks nothing, and records the question", async () => {
    const { app, audit } = appFor({ key: null });
    const response = await askOf(app, "Could the Sales Bot send email?");
    expect(response.status).toBe(503);
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit[0]?.payload).toMatchObject({ outcome: "no_model" });
  });

  test("only an admin can ask, check, explain or read the vocabulary, and the model is never called for anybody else", async () => {
    const { app, audit } = appFor({ role: "user" });
    expect((await askOf(app, "Could the Sales Bot send email?")).status).toBe(
      403,
    );
    expect((await checkOf(app, action({}))).status).toBe(403);
    expect((await app.request(`${BASE}/vocabulary`)).status).toBe(403);
    expect(
      (
        await app.request(
          `${BASE}/explain/00000000-0000-4000-8000-000000000000`,
        )
      ).status,
    ).toBe(403);
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit).toEqual([]);
  });
});

describe("checking an action the admin set", () => {
  /*
   * A kind of action is open by default, so what decides it is the gate's own answer: an admin who
   * closed the kind, or an allow the person saved from its card. Read from the kind alone, both once
   * showed "Built in: ... always asks" deciding, which was wrong both times.
   */
  test("a kind the team leaves to the person is handed off by that setting", async () => {
    const { app } = appFor({});
    await approvals.policy?.setTeamSettings(ADMIN.id, {
      actionKinds: { sending: "hand_off" },
    });
    try {
      const { body } = await checkOf(app, action({}));
      expect(body.result.outcome).toBe("hands_off");
      expect(body.result.decidedBy).toBe("safety");
      expect(layerOf(body.result, "safety")).toMatchObject({
        verdict: "hands_off",
        summary:
          "The team set sending something to other people to be left to the person.",
        basis: "Actions that ask first",
      });
    } finally {
      await approvals.policy?.setTeamSettings(ADMIN.id, {
        actionKinds: { sending: "open" },
      });
    }
  });

  test("an allow the person saved for the kind lets it through, and the approvals layer says whose", async () => {
    const { app } = appFor({});
    // As "Always allow here" on a sending card saves it: the rule with the kind it was given for.
    const [rule] = await database
      .insert(approvalRules)
      .values({
        id: crypto.randomUUID(),
        ownerUserId: SAM.id,
        botId: SALES_BOT.id,
        toolRef: `${GMAIL}/send_email`,
        effect: "write",
        scope: "*",
        kind: "sending",
      })
      .returning();
    try {
      const { body } = await checkOf(app, action({}));
      expect(body.result.outcome).toBe("allowed");
      expect(body.result.decidedBy).toBeNull();
      expect(layerOf(body.result, "safety")).toMatchObject({
        verdict: "allows",
        summary:
          "Built in: sending something to other people asks the person first, unless a rule or an allow saved for it decides. Here one does.",
      });
      expect(layerOf(body.result, "approvals")).toMatchObject({
        verdict: "allows",
        summary: "A personal rule lets it run without asking.",
      });
    } finally {
      if (rule) await approvals.revoke(SAM.id, rule.id);
    }
  });

  test("a member of a group the Permissions page turns commands off for is refused by the permission", async () => {
    const { app } = appFor({});
    const { body } = await checkOf(
      app,
      action({
        bot: RESEARCH_BOT.id,
        person: "",
        group: "whatif-contractors",
        initiator: "routine",
        surface: "computer",
        app: "",
        tool: "",
        intent: "run_command",
        command: "rm -rf build",
      }),
    );
    expect(body.result.decidedBy).toBe("capabilities");
    expect(layerOf(body.result, "capabilities")).toMatchObject({
      verdict: "refuses",
      basis: "Cloud computer use",
      summary:
        '"Cloud computer use" is off for members of whatif-contractors, set for members.',
    });
  });

  test("a member of the group that turns commands back on can run one, and every control lets it through", async () => {
    const { app } = appFor({});
    const { body } = await checkOf(
      app,
      action({
        person: "",
        group: "whatif-sales",
        surface: "computer",
        app: "",
        tool: "",
        intent: "run_command",
        command: "ls",
      }),
    );
    expect(body.result.outcome).toBe("allowed");
    expect(body.result.headline).toBe(
      "Allowed. Every control lets it through.",
    );
    expect(layerOf(body.result, "capabilities").summary).toBe(
      '"Use Bots" and "Cloud computer use" are on for members of whatif-sales.',
    );
  });

  test("the sales group's network allowlist refuses a site it doesn't list, and lets one it does", async () => {
    const { app } = appFor({});
    const open = (host: string) =>
      checkOf(
        app,
        action({
          surface: "computer",
          app: "",
          tool: "",
          intent: "navigate",
          host,
        }),
      );
    const refused = (await open("www.example.org")).body.result;
    expect(refused.decidedBy).toBe("network");
    expect(layerOf(refused, "network").summary).toBe(
      "www.example.org isn't allowed by the network allowlist for the group whatif-sales.",
    );
    const allowed = (await open("mail.google.com")).body.result;
    expect(layerOf(allowed, "network").verdict).toBe("allows");
    expect(allowed.outcome).toBe("allowed");
  });

  test("a tool the Bot was never given is refused by its grant first, though the allowlist would refuse it too", async () => {
    const { app } = appFor({});
    const { body } = await checkOf(
      app,
      action({
        bot: RESEARCH_BOT.id,
        person: CASEY.id,
        app: CRM,
        tool: "update_record",
      }),
    );
    expect(verdicts(body.result).slice(0, 2)).toEqual([
      ["grant", "refuses", "decides"],
      ["app_allowlist", "refuses", "unreached"],
    ]);
  });

  test("an action with nothing chosen says what to choose", async () => {
    const { app } = appFor({});
    const { status, body } = await checkOf(app, action({ bot: "" }));
    expect(status).toBe(400);
    expect(body as unknown).toEqual({ error: "Choose a Bot." });
  });
});

describe("why did this happen", () => {
  /** The row the real path just wrote for this Bot, of this type. */
  async function rowFor(eventType: string, bot: string, match = "") {
    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, eventType),
          gte(auditEvents.createdAt, startedAt),
          sql`${auditEvents.payload} ->> 'bot' = ${bot}`,
        ),
      );
    const row = rows
      .filter((one) => JSON.stringify(one.payload).includes(match))
      .at(-1);
    if (!row) throw new Error(`no ${eventType} row for ${bot}`);
    return row;
  }

  async function explain(id: string) {
    const { app, audit } = appFor({});
    const response = await app.request(`${BASE}/explain/${id}`);
    expect(response.status).toBe(200);
    return { body: await response.json(), audit };
  }

  test("an app call the boundary refused is explained by the same boundary, from the row alone", async () => {
    await expect(
      plugins.callTool({
        ref: `${GMAIL}/send_email`,
        args: {},
        botId: SALES_BOT.id,
        actorId: SAM.id,
        initiator: { kind: "routine", id: "nightly" },
      }),
    ).rejects.toThrow(PluginRefusedError);
    const row = await rowFor(
      "mcp.call_rejected",
      SALES_BOT.id,
      "No email when nobody is watching",
    );

    const { body, audit } = await explain(row.id);
    expect(body.recorded).toEqual({
      outcome: "refused",
      layer: "boundaries",
      summary: 'Refused by the boundary "No email when nobody is watching".',
    });
    expect(body.action).toEqual(action({ initiator: "routine" }));
    expect(body.result.decidedBy).toBe("boundaries");
    expect(layerOf(body.result, "boundaries").rule).toBe(NO_UNATTENDED_EMAIL);
    // No model is asked anything.
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit[0]).toMatchObject({
      eventType: "what_if.checked",
      payload: {
        from: "audit_row",
        eventId: row.id,
        outcome: "refused",
        decidedBy: "boundaries",
      },
    });
  });

  test("an app call the allowlist refused is explained by the allowlist", async () => {
    await expect(
      plugins.callTool({
        ref: `${CRM}/get_record`,
        args: {},
        botId: RESEARCH_BOT.id,
        actorId: CASEY.id,
      }),
    ).rejects.toThrow(PluginRefusedError);
    const row = await rowFor(
      "mcp.call_rejected",
      RESEARCH_BOT.id,
      "mcp_allowlist",
    );

    const { body } = await explain(row.id);
    expect(body.recorded.layer).toBe("app_allowlist");
    expect(verdicts(body.result).slice(0, 2)).toEqual([
      ["grant", "allows", ""],
      ["app_allowlist", "refuses", "decides"],
    ]);
  });

  test("an app call refused for a tool the Bot was never given is explained by its grant", async () => {
    await expect(
      plugins.callTool({
        ref: `${GMAIL}/send_email`,
        args: {},
        botId: RESEARCH_BOT.id,
        actorId: CASEY.id,
      }),
    ).rejects.toThrow(PluginRefusedError);
    const row = await rowFor(
      "mcp.call_rejected",
      RESEARCH_BOT.id,
      "not_granted",
    );

    const { body } = await explain(row.id);
    expect(body.recorded).toMatchObject({ outcome: "refused", layer: "grant" });
    expect(body.result.decidedBy).toBe("grant");
    // The row records no effect for a call refused before the policy; the tool's listing says write.
    expect(body.result.effect).toBe("write");
  });

  test("a computer action the boundary refused is explained by the boundary, with the page it was on", async () => {
    await expect(
      gateway.navigate(
        personSeat(CASEY.id, RESEARCH_BOT.id),
        { id: CASEY.id, userId: CASEY.id },
        "https://www.linkedin.com/",
      ),
    ).rejects.toThrow(ActionRefusedError);
    const row = await rowFor(
      "computer.action_refused",
      RESEARCH_BOT.id,
      "linkedin",
    );

    const { body } = await explain(row.id);
    expect(body.recorded.layer).toBe("boundaries");
    expect(body.action).toMatchObject({
      surface: "computer",
      intent: "navigate",
      host: "www.linkedin.com",
      person: CASEY.id,
    });
    expect(body.result.decidedBy).toBe("boundaries");
    expect(layerOf(body.result, "boundaries").basis).toBe("No social media");
  });

  test("a computer action the network allowlist refused is explained by the network allowlist", async () => {
    await expect(
      gateway.navigate(
        personSeat(SAM.id, SALES_BOT.id),
        { id: SAM.id, userId: SAM.id },
        "https://www.example.org/",
      ),
    ).rejects.toThrow(ActionRefusedError);
    const row = await rowFor(
      "computer.action_refused",
      SALES_BOT.id,
      "example.org",
    );
    expect((row.payload as { decision: { rule: string } }).decision.rule).toBe(
      "network:group:whatif-sales",
    );

    const { body } = await explain(row.id);
    expect(body.recorded.layer).toBe("network");
    expect(body.result.decidedBy).toBe("network");
  });

  test("a row no control decides has nothing to explain, and a row that isn't there says so", async () => {
    const { app } = appFor({});
    const [own] = await database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "configuration.changed"))
      .limit(1);
    if (own)
      expect((await app.request(`${BASE}/explain/${own.id}`)).status).toBe(422);
    expect(
      (
        await app.request(
          `${BASE}/explain/00000000-0000-4000-8000-000000000000`,
        )
      ).status,
    ).toBe(404);
    expect((await app.request(`${BASE}/explain/not-an-id`)).status).toBe(404);
  });
});
