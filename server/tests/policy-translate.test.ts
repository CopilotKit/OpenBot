import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { intentOf } from "../src/computer/gateway";
import { checkPolicyRule } from "../src/computer/policy";
import {
  COMPUTER_TOOLS,
  ruleProblem,
  ruleWarning,
} from "../src/computer/policy-translate";
import { loadConfig } from "../src/config";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/policy-translate-recorded.json";
import { testEnvironment } from "./support/environment";

/**
 * An admin describes a boundary in English and gets a rule back: written by the deployment's model,
 * compiled, corrected once when it does not compile, and read back by a call that never sees the
 * description.
 *
 * Through the real route in `createApp`, behind the computer router's Bot guard, with the model
 * answered by aimock serving answers recorded from the real API to these exact prompts
 * (`fixtures/policy-translate-recorded.json`).
 */

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
      { userMessage: /You explain one OpenBot boundary rule/ },
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
  // The policy routes and the Bot guard in front of every computer path, as the deployment mounts them.
  args[7] = {} as never;
  args[8] = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  } as never;
  args[12] = {
    insert: async (event: AuditEventInput) => {
      audit.push(event);
    },
  } as never;
  args[34] = {
    boundaryWriter: createModelCompleter({
      model: {
        provider: "openai",
        defaultModel: options.model ?? "gpt-5.6-terra",
      },
      resolveApiKey: async () =>
        options.key === undefined ? "test-key" : options.key,
    }),
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return { app: build(...args), audit };
}

function translate(app: ReturnType<typeof createApp>, text: unknown) {
  return app.request("http://localhost:3001/api/computers/policy-translate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify({ text }),
  });
}

/** The prompt each model request carried, in order. */
function prompts(): string[] {
  return mock.getRequests().map((entry) => {
    const messages = (entry.body as { messages?: { content?: unknown }[] })
      ?.messages;
    return String(messages?.at(-1)?.content ?? "");
  });
}

describe("POST /api/computers/policy-translate", () => {
  test("a description that compiles first time comes back with its rule, an independent reading and a passing compile", async () => {
    const recording = recorded.compilesFirstTime;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const written = JSON.parse(recording.writer[0] as string);
    const reading = JSON.parse(recording.reader);
    // A one-line summary for "What it stops", from the same reading, in the words the list uses.
    expect(reading.summary).toStartWith("Stops a Bot");
    expect(body).toEqual({
      rule: written.rule,
      effect: "deny",
      summary: reading.summary,
      explanation: reading.explanation,
      compile: { ok: true },
      warning: null,
    });

    // One rule, then one reading of it. The reading was asked with the rule and never the request.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    expect(asked[1]).toContain(written.rule);
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("social media");

    // Structured output, held to the rule's own schema.
    const firstBody = mock.getRequests()[0]?.body as {
      response_format?: unknown;
    };
    expect(firstBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "boundary_rule", strict: true },
    });

    expect(audit).toEqual([
      {
        eventType: "computer.policy_translated",
        targetType: "policy",
        actorUserId: ADMIN.id,
        payload: {
          actor: ADMIN.email,
          text: recording.text,
          outcome: "written",
          rule: written.rule,
          effect: "deny",
          summary: reading.summary,
          explanation: reading.explanation,
          warning: null,
          compiled: true,
          attempts: 1,
        },
      },
    ]);
  });

  test("a rule that does not compile is sent back to the model with the compiler's error, and the corrected rule is returned", async () => {
    const recording = recorded.fixedOnRetry;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const firstRule = JSON.parse(recording.writer[0] as string).rule as string;
    const fixed = JSON.parse(recording.writer[1] as string).rule as string;
    // The first answer wrote `\d`, standard CEL, which this engine keeps as two characters.
    expect(ruleProblem(firstRule)).not.toBeNull();
    expect(body.rule).toBe(fixed);
    expect(body.compile).toEqual({ ok: true });
    expect(body.explanation).toBe(JSON.parse(recording.reader).explanation);
    expect(body.summary).toBe(JSON.parse(recording.reader).summary);

    const asked = prompts();
    expect(asked).toHaveLength(3);
    expect(asked[1]).toContain(firstRule);
    expect(asked[1]).toContain(ruleProblem(firstRule) as string);
    expect(asked[2]).toContain(fixed);
    expect(asked[2]).not.toContain(recording.text);

    expect(audit[0]?.payload).toMatchObject({
      outcome: "written",
      rule: fixed,
      compiled: true,
      attempts: 2,
    });
  });

  test("a rule that never compiles is returned with the error, unexplained, after two attempts", async () => {
    const recording = recorded.neverCompiles;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const last = JSON.parse(recording.writer[1] as string).rule as string;
    const compiled = checkPolicyRule(last);
    expect(compiled.ok).toBe(false);
    expect(body).toEqual({
      rule: last,
      effect: "deny",
      summary: null,
      explanation: null,
      compile: compiled,
      warning: null,
    });
    // Two writes and no reading: a rule that does not compile is not explained as though it worked.
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "did_not_compile",
      compiled: false,
      attempts: 2,
      error: (compiled as { error: string }).error,
    });
  });

  test("with no model set up it says one is needed, asks nothing, and records the request", async () => {
    const { app, audit } = appFor({ key: null });

    const response = await translate(
      app,
      "Bots may not visit social media sites",
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "OpenBot needs a model key to write a rule from a description. Add one on the Credentials page, or write the rule in CEL.",
    });
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit.map((event) => event.payload)).toEqual([
      {
        actor: ADMIN.email,
        text: "Bots may not visit social media sites",
        outcome: "no_model",
      },
    ]);
  });

  test("only an admin can ask, and the model is never called for anybody else", async () => {
    const { app, audit } = appFor({ role: "user" });

    const response = await translate(
      app,
      "Bots may not visit social media sites",
    );

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

describe("the rule's checks", () => {
  test("rules from the shipped templates and the model's own compile", () => {
    for (const rule of [
      '(intent == "activate" && contains(element.name, "submit")) || ((tool.name == "computer_key" || tool.name == "computer_type") && intent == "activate")',
      'intent == "type" && contains(element.name, "password")',
      'mcp.effect == "write" && contains(mcp.server, "salesforce")',
      'intent == "download_file" && file.extension in ["exe", "msi"]',
      'intent == "run_command" && initiator.kind != "person"',
    ])
      expect(checkPolicyRule(rule)).toEqual({ ok: true });
  });

  /*
   * The compiler is the boundaries' own (checkPolicyRule, tested in policy-rule-check.test.ts). These
   * are the shapes a model actually wrote here, held against it. The last two were written by
   * gpt-4o-mini for "Block any URL with a query string longer than 200 characters", through the real
   * screen: each runs cleanly on every action whose URL has no `?`, because `&&` stops before the
   * method call, and throws, refusing, on the first one that does. A check that only ran the rule
   * passed both, and the screen said they compiled.
   */
  test.each([
    ['page.host.endsWith(".ru")', "endsWith"],
    ['intent == "navigate" && page.domain == "x"', "page.domain"],
    ['request.url == "x"', "request"],
    ['"Submit order"', "true or false"],
    [
      'intent == "navigate" && (page.url != "" && contains(page.url, "?") && (contains(page.url, "?") ? (page.url.length - (indexOf(page.url, "?") + 1)) > 200 : false))',
      "page.url",
    ],
    [
      "contains(page.url, '?') && (page.url.split('?')[1].length > 200)",
      "split",
    ],
  ])(
    "a model's rule %s does not compile, and the error names %s",
    (rule, named) => {
      const compiled = checkPolicyRule(rule);
      expect(compiled.ok).toBe(false);
      expect((compiled as { error: string }).error).toContain(named);
    },
  );

  test("a backslash is refused, because cel-js keeps it and the pattern stops matching", () => {
    expect(
      ruleProblem('matches(page.host, "(^|\\\\.)x\\\\.com$")'),
    ).not.toBeNull();
    expect(ruleProblem('matches(page.host, "(^|[.])x[.]com$")')).toBeNull();
  });

  test("a rule that answers the same for every action is called out", () => {
    expect(ruleWarning("false", "deny")).toBe(
      "This rule matches no action, so it would stop nothing. A rule can't check that description.",
    );
    expect(ruleWarning("true", "deny")).toBe(
      "This rule matches every action, so it would stop everything every Bot does.",
    );
    expect(ruleWarning('intent == "navigate"', "deny")).toBeNull();
    expect(ruleWarning('contains(command, "rm")', "deny")).toBeNull();
  });

  test("every tool the writer is told about reaches the policy with the intent it is told", () => {
    for (const entry of COMPUTER_TOOLS)
      expect([entry.tool, intentOf(entry.tool, entry.key)]).toEqual([
        entry.tool,
        entry.intent,
      ]);
  });
});
