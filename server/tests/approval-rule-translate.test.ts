import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { HANDOFF_TOOL } from "../src/agents/handoff-tool";
import { createApp } from "../src/app";
import { checkRuleRows, ruleRowsWarning } from "../src/approvals/rule-check";
import {
  COMPUTER_APPROVAL_TOOLS,
  HANDOFF_APPROVAL_TOOL,
  PRIVATE_SHARE_APPROVAL_TOOL,
  type RuleVocabulary,
} from "../src/approvals/rule-vocabulary";
import type { ApprovalRuleInput } from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import { intentOf } from "../src/computer/gateway";
import { COMPUTER_TOOLS } from "../src/computer/policy-translate";
import { loadConfig } from "../src/config";
import {
  PRIVATE_SHARE_EFFECT,
  PRIVATE_SHARE_TOOL_REF,
} from "../src/proactive/private-share";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/approval-rules-recorded.json";
import vocabularyFixture from "./fixtures/approval-rules-vocabulary.json";
import { testEnvironment } from "./support/environment";

/**
 * An admin describes team approval rules in English and gets rule rows back: written by the
 * deployment's model from this OpenBot's real apps and Bots, checked against the gate's own matcher,
 * sent back once when they don't check, and read back by a call that never sees the description.
 *
 * Through the real route in `createApp`, with the model answered by aimock serving answers recorded
 * from the real API to these prompts (`fixtures/approval-rules-recorded.json`), over Composio's own
 * Gmail, Salesforce and Slack listings (`fixtures/approval-rules-vocabulary.json`).
 */

const vocabulary = vocabularyFixture as RuleVocabulary;

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

const mock = new LLMock();
let base = "";
const originalBaseUrl = process.env.OPENAI_BASE_URL;

beforeAll(async () => {
  base = await mock.start();
  process.env.OPENAI_BASE_URL = base;
});

afterEach(() => {
  mock.clearFixtures();
  mock.clearRequests();
});

afterAll(async () => {
  await mock.stop();
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
});

type Case = {
  model: string;
  text: string;
  writer: string[];
  reader?: string;
};

/** The writer's attempts in order, then the reader, each matched by what only its prompt carries. */
function serve(recording: Case) {
  const [first, second] = recording.writer;
  if (second)
    mock.on({ userMessage: /The checker said:/ }, { content: second });
  if (first) mock.on({ userMessage: /<description>/ }, { content: first });
  if (recording.reader)
    mock.on(
      { userMessage: /You explain team approval rules/ },
      { content: recording.reader },
    );
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
    api: { getSession: async () => ({ user: ADMIN }) },
  } as never;
  args[2] = {
    rolesForUser: async () => [options.role ?? "admin"],
  } as never;
  args[12] = {
    insert: async (event: AuditEventInput) => {
      audit.push(event);
    },
  } as never;
  args[34] = {
    approvals: { store: {} },
    boundaryWriter: createModelCompleter({
      model: {
        provider: "openai",
        defaultModel: options.model ?? "gpt-5.6-terra",
      },
      resolveApiKey: async () =>
        options.key === undefined ? "test-key" : options.key,
    }),
    approvalRules: { vocabulary: async () => vocabulary },
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return { app: build(...args), audit };
}

function translate(app: ReturnType<typeof createApp>, text: unknown) {
  return app.request(
    "http://localhost:3001/api/approvals/team/rules/translate",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify({ text }),
    },
  );
}

/** The prompt each model request carried, in order. */
function prompts(): string[] {
  return mock.getRequests().map((entry) => {
    const messages = (entry.body as { messages?: { content?: unknown }[] })
      ?.messages;
    return String(messages?.at(-1)?.content ?? "");
  });
}

const rowsOf = (answer: string) =>
  (JSON.parse(answer) as { rules: ApprovalRuleInput[] }).rules;

describe("POST /api/approvals/team/rules/translate", () => {
  test("a description that checks first time comes back with its rows, an independent reading and a passing check", async () => {
    const recording = recorded.checksFirstTime;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const rules = rowsOf(recording.writer[0] as string);
    const reading = JSON.parse(recording.reader);
    // The model's rows, named from the real Gmail listing, and the reading's own sentence.
    expect(rules).toEqual([
      {
        toolRef: "composio-gmail/GMAIL_SEND_*",
        effect: "write",
        scope: "composio-gmail",
        botId: "*",
        behaviour: "ask",
      },
    ]);
    expect(body).toEqual({
      rules,
      summary: reading.summary,
      explanation: reading.explanation,
      check: { ok: true },
      warning: null,
    });

    // One writing, then one reading of it. The reading was asked with the rows and never the request.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    // The writer is told this OpenBot's real tools, effects and Bots.
    expect(asked[0]).toContain("GMAIL_SEND_EMAIL [write]");
    expect(asked[0]).toContain("GMAIL_FETCH_EMAILS [read]");
    expect(asked[0]).toContain("Sales Assistant");
    expect(asked[1]).toContain("composio-gmail/GMAIL_SEND_*");
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("sends email");
    // The reader is told what the glob covers, so it reads it as the gate does: the reply tool is
    // not a send, and the reading says the rule covers only two tools.
    expect(asked[1]).toContain(
      "Rule 1 covers 2 tools: composio-gmail/GMAIL_SEND_DRAFT, composio-gmail/GMAIL_SEND_EMAIL.",
    );

    // Structured output, held to the rows' own schema.
    const firstBody = mock.getRequests()[0]?.body as {
      response_format?: unknown;
    };
    expect(firstBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "approval_rules", strict: true },
    });

    expect(audit).toEqual([
      {
        eventType: "approval.rules_translated",
        targetType: "approval_rule",
        actorUserId: ADMIN.id,
        payload: {
          actor: ADMIN.email,
          text: recording.text,
          outcome: "written",
          rules,
          summary: reading.summary,
          explanation: reading.explanation,
          warning: null,
          checked: true,
          attempts: 1,
        },
      },
    ]);
  });

  test("rows that don't check are sent back to the model with what is wrong, and the corrected rows are returned", async () => {
    const recording = recorded.fixedOnRetry;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    // The first answer copied the old form's spelling, which no tool here has.
    const first = rowsOf(recording.writer[0] as string);
    expect(first[0]?.toolRef).toBe("mcp/gmail/*");
    const firstCheck = checkRuleRows(first, vocabulary);
    expect(firstCheck.ok).toBe(false);
    const fixed = rowsOf(recording.writer[1] as string);
    expect(fixed).toEqual([
      {
        toolRef: "composio-gmail/*",
        effect: "*",
        scope: "composio-gmail",
        botId: "*",
        behaviour: "ask",
      },
    ]);
    expect(body.rules).toEqual(fixed);
    expect(body.check).toEqual({ ok: true });
    expect(body.explanation).toBe(JSON.parse(recording.reader).explanation);

    const asked = prompts();
    expect(asked).toHaveLength(3);
    // The retry carried the rows and the checker's own words, which name the real apps.
    expect(asked[1]).toContain('"toolRef":"mcp/gmail/*"');
    expect(asked[1]).toContain(
      (firstCheck as { error: string }).error as string,
    );
    expect(asked[1]).toContain("no tool here starts with mcp/");
    expect(asked[2]).toContain("composio-gmail/*");
    expect(asked[2]).not.toContain(recording.text);

    expect(audit[0]?.payload).toMatchObject({
      outcome: "written",
      rules: fixed,
      checked: true,
      attempts: 2,
    });
  });

  test("rows that never check are returned with the error, unexplained, after two attempts", async () => {
    const recording = recorded.bothAttemptsUnchecked;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const last = rowsOf(recording.writer[1] as string);
    // HubSpot isn't set up here, and the model wrote it anyway, twice.
    expect(last[0]?.toolRef).toBe("composio-hubspot/*");
    const check = checkRuleRows(last, vocabulary);
    expect(check.ok).toBe(false);
    expect(body).toEqual({
      rules: last,
      summary: null,
      explanation: null,
      check,
      warning: null,
    });
    expect((check as { error: string }).error).toBe(
      'Tool or app: "composio-hubspot/*" matches no tool OpenBot has. Apps set up: composio-gmail, composio-salesforce, composio-slack.',
    );
    // Two writings and no reading: rows that don't check are not explained as though they worked.
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "did_not_check",
      checked: false,
      attempts: 2,
      error: (check as { error: string }).error,
    });
  });

  test("a model that gives up on the retry is an honest failure, with its own reason and no rows", async () => {
    const recording = recorded.neverChecks;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const notes = JSON.parse(recording.writer[1] as string).notes as string;
    expect(body).toEqual({
      rules: [],
      summary: null,
      explanation: null,
      check: {
        ok: false,
        error: `No rules were written. ${notes}`,
        problems: [],
      },
      warning: null,
    });
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "did_not_check",
      rules: [],
      attempts: 2,
    });
  });

  test("a description naming nothing set up is answered with the model's reason, without pressing it again", async () => {
    const recording = recorded.noRuleWritten;
    serve(recording);
    const { app } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rules).toEqual([]);
    expect(body.check.ok).toBe(false);
    expect(body.check.error).toStartWith("No rules were written.");
    expect(body.check.error).toContain("HubSpot");
    // Asked once: a second request would only press it to invent an app.
    expect(prompts()).toHaveLength(1);
  });

  test("with no model set up it says one is needed, asks nothing, and records the request", async () => {
    const { app, audit } = appFor({ key: null });

    const response = await translate(app, "Ask before any Bot sends email");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "OpenBot needs a model key to write rules from a description. Add one on the Credentials page, or add the rule by hand.",
    });
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit.map((event) => event.payload)).toEqual([
      {
        actor: ADMIN.email,
        text: "Ask before any Bot sends email",
        outcome: "no_model",
      },
    ]);
  });

  test("only an admin can ask, and the model is never called for anybody else", async () => {
    const { app, audit } = appFor({ role: "user" });

    const response = await translate(app, "Ask before any Bot sends email");

    expect(response.status).toBe(403);
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit).toEqual([]);
  });

  test.each([
    ["nothing", undefined],
    ["blank", "   "],
    ["not text", 42],
  ])(
    "a description that is %s is refused before the model",
    async (_name, text) => {
      const { app } = appFor({});
      const response = await translate(app, text);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Describe the rule in a sentence first.",
      });
      expect(mock.getRequests()).toHaveLength(0);
    },
  );
});

const row = (over: Partial<ApprovalRuleInput>): ApprovalRuleInput => ({
  toolRef: "composio-gmail/*",
  effect: "write",
  scope: "composio-gmail",
  botId: "*",
  behaviour: "ask",
  ...over,
});

describe("the rows' check", () => {
  test("rows the model wrote for real descriptions check", () => {
    for (const rules of [
      rowsOf(recorded.checksFirstTime.writer[0] as string),
      rowsOf(recorded.siteRule.writer[0] as string),
      rowsOf(recorded.fixedOnRetry.writer[1] as string),
      [
        row({
          toolRef: "composio-salesforce/*",
          effect: "read",
          scope: "composio-salesforce",
          botId: "agent_0b6c1d2e-7a44-4a0e-9a59-2f0d5c3e8b11",
          behaviour: "allow",
        }),
      ],
      [row({ toolRef: "computer_run_command", scope: "workspace" })],
      [row({ toolRef: "bot/message_bot", effect: "delegate", scope: "*" })],
    ])
      expect(checkRuleRows(rules, vocabulary)).toEqual({ ok: true });
  });

  /*
   * The ways a glob that "compiles" still matches nothing, each with what is wrong in words. The
   * first is what the Add a team rule form's own placeholder suggested: no tool starts with mcp/.
   */
  test.each([
    [
      "the old form's mcp/ spelling",
      row({ toolRef: "mcp/gmail/*" }),
      "toolRef",
      "no tool here starts with mcp/",
    ],
    [
      "the old spelling, pointed at the app it meant",
      row({ toolRef: "mcp/salesforce/*", scope: "composio-salesforce" }),
      "toolRef",
      "such as composio-salesforce/*.",
    ],
    [
      "a regular expression",
      row({ toolRef: "composio-gmail/GMAIL_SEND_.*" }),
      "toolRef",
      "written like a regular expression",
    ],
    [
      "alternation",
      row({ toolRef: "composio-gmail/GMAIL_(SEND|REPLY)_*" }),
      "toolRef",
      "written like a regular expression",
    ],
    [
      "an app that is not set up",
      row({ toolRef: "composio-hubspot/*", scope: "composio-hubspot" }),
      "toolRef",
      "matches no tool OpenBot has",
    ],
    [
      "a tool the app does not have",
      row({ toolRef: "composio-gmail/GMAIL_SEND_FAX" }),
      "toolRef",
      "is not a tool OpenBot has. composio-gmail has: GMAIL_ADD_LABEL_TO_EMAIL",
    ],
    [
      "a kind of action the tool never takes",
      row({ toolRef: "composio-gmail/GMAIL_SEND_EMAIL", effect: "read" }),
      "effect",
      "is not a kind of action that tool takes. It takes: write.",
    ],
    [
      "an app's tool aimed at a site",
      row({ scope: "mail.google.com" }),
      "scope",
      "is never the target of a composio-gmail tool",
    ],
    [
      "a Bot that does not exist",
      row({ botId: "marketing-bot" }),
      "botId",
      'No Bot\'s id is "marketing-bot". Bots: agent_0b6c1d2e-7a44-4a0e-9a59-2f0d5c3e8b11 (Research)',
    ],
    ["an empty pattern", row({ effect: "" }), "effect", "It is empty."],
  ])("%s is refused, and the error says why", (_name, rule, field, words) => {
    const check = checkRuleRows([rule], vocabulary);
    expect(check.ok).toBe(false);
    const problems = (
      check as { problems: { field: string; message: string }[] }
    ).problems;
    expect(problems.map((problem) => problem.field)).toEqual([field]);
    expect(problems[0]?.message).toContain(words);
  });

  test("a problem in the second of several rows is named by its row", () => {
    const check = checkRuleRows(
      [row({}), row({ toolRef: "composio-gmail/NOPE" })],
      vocabulary,
    );
    expect((check as { error: string }).error).toStartWith(
      'Rule 2, Tool or app: "composio-gmail/NOPE" is not a tool OpenBot has.',
    );
  });

  test("rows that cover every action every Bot takes are called out, not refused", () => {
    const everything = row({ toolRef: "*", effect: "*", scope: "*" });
    expect(checkRuleRows([everything], vocabulary)).toEqual({ ok: true });
    expect(ruleRowsWarning([everything])).toBe(
      "This rule covers every action every Bot takes, including every page it reads.",
    );
    expect(
      ruleRowsWarning([row({}), { ...everything, behaviour: "allow" }]),
    ).toBe(
      "Rule 2 covers every action every Bot takes, so Bots stop asking before changes unless a stricter rule or a safety requirement asks.",
    );
    expect(ruleRowsWarning([row({})])).toBeNull();
  });
});

describe("the vocabulary the writer is given", () => {
  test("every computer tool reaches the gate with the effect it is listed under", () => {
    // The gateway's own rule (computer/gateway.ts): activating, typing, saving and running write.
    const effectOf = (tool: string, key?: string) =>
      ["activate", "type", "write_file", "run_command"].includes(
        intentOf(tool, key) ?? "",
      )
        ? "write"
        : "read";
    for (const entry of COMPUTER_TOOLS) {
      const listed = COMPUTER_APPROVAL_TOOLS.find(
        (tool) => tool.ref === entry.tool,
      );
      expect(listed?.effects).toContain(effectOf(entry.tool, entry.key));
    }
    expect(COMPUTER_APPROVAL_TOOLS.map((tool) => tool.ref).sort()).toEqual(
      [...new Set(COMPUTER_TOOLS.map((entry) => entry.tool))].sort(),
    );
  });

  test("a hand-off and a private share are named as the gate is asked about them", () => {
    expect(HANDOFF_APPROVAL_TOOL.ref).toBe(`bot/${HANDOFF_TOOL}`);
    expect(PRIVATE_SHARE_APPROVAL_TOOL).toMatchObject({
      ref: PRIVATE_SHARE_TOOL_REF,
      effects: [PRIVATE_SHARE_EFFECT],
    });
  });
});
