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
import {
  type AskAnswer,
  type AuditVocabulary,
  checkAskAnswer,
  describeFilters,
  readingPrompt,
  recentMidnights,
} from "../src/audit-ask";
import { loadConfig } from "../src/config";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/audit-ask-recorded.json";
import deployment from "./fixtures/audit-ask-vocabulary.json";
import { testEnvironment } from "./support/environment";

/**
 * An admin asks the audit trail a question in English and gets filters back: chosen by the
 * deployment's model, checked against what this deployment has, corrected once when they fail the
 * check, and read back in one line by a call that never sees the question.
 *
 * Through the real route in `createApp`, with the model answered by aimock serving answers recorded
 * from the real API to these exact prompts (`fixtures/audit-ask-recorded.json`), asked of the
 * deployment in `fixtures/audit-ask-vocabulary.json`.
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

const vocabulary = deployment.vocabulary as AuditVocabulary;
const asked = {
  now: new Date(deployment.asked.now),
  timeZone: deployment.asked.timeZone,
};

const mock = new LLMock();
const originalBaseUrl = process.env.OPENAI_BASE_URL;

beforeAll(async () => {
  process.env.OPENAI_BASE_URL = await mock.start();
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

type Case = { model: string; text: string; writer: string[]; reader?: string };

const CONTRADICTION =
  "apps, tools and effect match only app calls (mcp.call_succeeded, mcp.call_failed, mcp.call_rejected), and eventTypes names none of them, so no row can match. Leave eventTypes empty or name app call types.";

/** The writer's attempts in order, then the reader, each matched by what only its prompt carries. */
function serve(recording: Case) {
  const [first, second] = recording.writer;
  if (second)
    mock.on({ userMessage: /What was wrong with it:/ }, { content: second });
  if (first) mock.on({ userMessage: /<question>/ }, { content: first });
  if (recording.reader)
    mock.on(
      { userMessage: /You read one set of filters/ },
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
    auditQuestions: {
      complete: createModelCompleter({
        model: {
          provider: "openai",
          defaultModel: options.model ?? "gpt-5.6-terra",
        },
        resolveApiKey: async () =>
          options.key === undefined ? "test-key" : options.key,
      }),
      vocabulary: async () => vocabulary,
      now: () => asked.now,
    },
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return { app: build(...args), audit };
}

function ask(app: ReturnType<typeof createApp>, question: unknown) {
  return app.request("http://localhost:3001/api/admin/audit-events/ask", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify({ question, timeZone: asked.timeZone }),
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

describe("POST /api/admin/audit-events/ask", () => {
  test("a question the trail answers comes back as checked filters, read back by a call that never saw it", async () => {
    const recording = recorded.answered;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await ask(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const reading = JSON.parse(recording.reader as string).reading;
    // "Every Gmail write by a routine last week", Monday to Monday where the admin is.
    expect(body).toEqual({
      answerable: "yes",
      unanswered: null,
      filters: {
        initiatorKind: ["routine"],
        app: ["gmail"],
        effect: "write",
        from: "2026-11-02T08:00:00.000Z",
        to: "2026-11-09T08:00:00.000Z",
      },
      reading,
      labels: { bots: {}, people: {}, apps: { gmail: "Gmail" }, rules: {} },
    });

    // The filters, then one reading of them. The reading was asked with the filters, never the question.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    expect(asked[0]).toContain("4b1f7c2e-research: Research");
    expect(asked[1]).toContain("App calls to any of: Gmail");
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("last week");

    // Structured output, held to the filters' own schema.
    expect(
      (mock.getRequests()[0]?.body as { response_format?: unknown } | undefined)
        ?.response_format,
    ).toMatchObject({
      type: "json_schema",
      json_schema: { name: "audit_filters", strict: true },
    });

    expect(audit).toEqual([
      {
        eventType: "audit.asked",
        targetType: "audit_trail",
        actorUserId: ADMIN.id,
        payload: {
          actor: ADMIN.email,
          question: recording.text,
          outcome: "answered",
          filters: body.filters,
          reading,
          unanswered: null,
          attempts: 1,
        },
      },
    ]);
  });

  test("filters that fail the check go back to the model with what was wrong, and its second answer, checked again, is what is returned", async () => {
    const recording = recorded.fixedOnRetry;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await ask(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const first = JSON.parse(recording.writer[0] as string);
    const second = JSON.parse(recording.writer[1] as string);
    // The smaller model's first answer asked for delivery rows beside Slack's app calls, which no
    // row is both: an empty table that would have read as "no Bot posted anything".
    expect(first.eventTypes).toEqual(["delivery.sent"]);
    expect(
      checkAskAnswer(first as AskAnswer, vocabulary, asked).problems,
    ).toEqual([CONTRADICTION]);

    const sent = prompts();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(recording.writer[0] as string);
    expect(sent[1]).toContain(`- ${CONTRADICTION}`);

    // The second answer passed the check and is the answer, whatever it says.
    expect(body).toEqual({
      answerable: second.answerable,
      unanswered: second.unanswered,
      filters: {},
      reading: null,
      labels: { bots: {}, people: {}, apps: {}, rules: {} },
    });
    expect(audit[0]?.payload).toMatchObject({
      outcome: "unanswerable",
      attempts: 2,
    });
  });

  test("a question the trail can't answer says why, with no filters and no rows", async () => {
    const recording = recorded.unanswerable;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await ask(app, recording.text);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      answerable: "no",
      unanswered: JSON.parse(recording.writer[0] as string).unanswered,
      filters: {},
      reading: null,
      labels: { bots: {}, people: {}, apps: {}, rules: {} },
    });
    // Nothing to read back: one call.
    expect(prompts()).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      question: recording.text,
      outcome: "unanswerable",
      filters: {},
      reading: null,
    });
  });

  test("a question the trail answers in part shows the rows it has and says what it can't", async () => {
    const recording = recorded.partly;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await ask(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    // "What did it change": the calls are on the trail, the records and fields they changed are not.
    expect(body.answerable).toBe("partly");
    expect(body.unanswered).toBe(
      JSON.parse(recording.writer[0] as string).unanswered,
    );
    expect(body.unanswered).toContain("Salesforce");
    expect(body.filters).toEqual({
      bot: "4b1f7c2e-research",
      app: ["salesforce"],
      from: "2026-11-08T08:00:00.000Z",
      to: "2026-11-09T08:00:00.000Z",
    });
    expect(body.reading).toBe(JSON.parse(recording.reader as string).reading);
    expect(body.labels.bots).toEqual({ "4b1f7c2e-research": "Research" });
    expect(audit[0]?.payload).toMatchObject({ outcome: "partly_answered" });
  });

  test("filters that fail the check twice are refused, never guessed at, and the problems are recorded", async () => {
    const bad = recorded.fixedOnRetry.writer[0] as string;
    serve({ ...recorded.fixedOnRetry, writer: [bad, bad] });
    const { app, audit } = appFor({ model: recorded.fixedOnRetry.model });

    const response = await ask(app, recorded.fixedOnRetry.text);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        "Couldn't turn that question into filters. Ask it another way, or set the filters yourself.",
    });
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "not_valid",
      attempts: 2,
      problems: [CONTRADICTION],
    });
  });

  test("with no model set up it says one is needed, asks nothing, and records the question", async () => {
    const { app, audit } = appFor({ key: null });

    const response = await ask(app, "What did Bots do in Gmail today?");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "OpenBot needs a model key to answer a question. Add one on the Credentials page, or set the filters yourself.",
    });
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit.map((event) => event.payload)).toEqual([
      {
        actor: ADMIN.email,
        question: "What did Bots do in Gmail today?",
        outcome: "no_model",
      },
    ]);
  });

  test("only an admin can ask or read the vocabulary, and the model is never called for anybody else", async () => {
    const { app, audit } = appFor({ role: "user" });

    expect((await ask(app, "What did Bots do in Gmail today?")).status).toBe(
      403,
    );
    expect(
      (
        await app.request(
          "http://localhost:3001/api/admin/audit-events/vocabulary",
        )
      ).status,
    ).toBe(403);
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit).toEqual([]);
  });

  test("an admin reads the vocabulary the chips are edited from", async () => {
    const { app } = appFor({});
    const response = await app.request(
      "http://localhost:3001/api/admin/audit-events/vocabulary",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(vocabulary);
  });

  test.each([
    ["nothing", undefined],
    ["blank", "   "],
    ["not text", 42],
  ])(
    "a question that is %s is refused before the model",
    async (_name, text) => {
      const { app } = appFor({});
      const response = await ask(app, text);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Ask a question first." });
      expect(mock.getRequests()).toHaveLength(0);
    },
  );
});

/** An answer with nothing set but what a test names. */
function answer(overrides: Partial<AskAnswer>): AskAnswer {
  return {
    answerable: "yes",
    unanswered: "",
    eventTypes: [],
    bot: "",
    person: "",
    initiatorKinds: [],
    apps: [],
    tools: [],
    effect: "",
    intents: [],
    rule: "",
    from: "",
    to: "",
    ...overrides,
  };
}

describe("the check on the model's filters", () => {
  test("a day that does not exist is refused, though this runtime would read it as the next one", () => {
    expect(Date.parse("2026-11-31T00:00:00-08:00")).not.toBeNaN();
    const { problems } = checkAskAnswer(
      answer({
        apps: ["gmail"],
        from: "2026-11-31T00:00:00-08:00",
        to: "2026-12-01T00:00:00-08:00",
      }),
      vocabulary,
      { ...asked, now: new Date("2026-12-02T00:00:00Z") },
    );
    expect(problems).toEqual([
      'from (2026-11-31T00:00:00-08:00) must be a real date in ISO 8601 with an offset, such as "2026-11-02T00:00:00-08:00".',
    ]);
  });

  test("a range that ends after now, or starts after it ends, is refused", () => {
    expect(
      checkAskAnswer(
        answer({ to: "2026-11-10T00:00:00-08:00" }),
        vocabulary,
        asked,
      ).problems,
    ).toEqual([
      'to (2026-11-10T00:00:00-08:00) is after now (2026-11-09T13:05:00-08:00). Leave to "" for "until now".',
    ]);
    expect(
      checkAskAnswer(
        answer({
          from: "2026-11-05T00:00:00-08:00",
          to: "2026-11-04T00:00:00-08:00",
        }),
        vocabulary,
        asked,
      ).problems,
    ).toEqual([
      "from (2026-11-05T00:00:00-08:00) must be before to (2026-11-04T00:00:00-08:00).",
    ]);
  });

  /*
   * gpt-4o-mini's real answer to "Which Gmail emails did sam@example.com's Bots send in the last 3
   * days?": a delivery row beside Gmail's tools, which no row is both. The table would have been
   * empty, and read as "they sent none".
   */
  test("filters that ask for two kinds of row at once are refused", () => {
    const { problems } = checkAskAnswer(
      answer({
        eventTypes: ["delivery.sent"],
        person: "user-sam",
        apps: ["gmail"],
        tools: ["GMAIL_SEND_EMAIL"],
        effect: "write",
      }),
      vocabulary,
      asked,
    );
    expect(problems).toEqual([CONTRADICTION]);
    expect(
      checkAskAnswer(
        answer({
          eventTypes: ["mcp.call_failed"],
          rule: 'mcp.effect == "write" && contains(mcp.server, "salesforce")',
        }),
        vocabulary,
        asked,
      ).problems,
    ).toEqual([
      "Only refusals carry a rule (computer.action_refused, mcp.call_rejected), and eventTypes names neither, so no row can match. Leave eventTypes empty.",
    ]);
  });

  test("a Bot, a person and an app are resolved from the deployment, by id or by name", () => {
    const { filters, problems } = checkAskAnswer(
      answer({
        bot: "Sales assistant",
        person: "dana@example.com",
        apps: ["composio-gmail", "Google Drive"],
        tools: ["gmail_send_email"],
      }),
      vocabulary,
      asked,
    );
    expect(problems).toEqual([]);
    expect(filters).toEqual({
      bot: "9a0d3e51-sales",
      actorUserId: "user-dana",
      app: ["gmail", "googledrive"],
      tool: ["GMAIL_SEND_EMAIL"],
    });
    /*
     * A rule by its name. FOUND ON THE REAL PAGE: asked to copy a long rule's text, the default model
     * got it wrong twice and the question was refused.
     */
    for (const named of ["Social media", '"social media"'])
      expect(
        checkAskAnswer(answer({ rule: named }), vocabulary, asked).filters.rule,
      ).toBe(vocabulary.rules[0]?.rule);
    expect(
      checkAskAnswer(answer({ bot: "finance" }), vocabulary, asked).problems,
    ).toEqual([
      'No Bot has the id or name "finance". Use an id from BOTS, or leave bot "" and say in "unanswered" that there is no such Bot.',
    ]);
  });
});

/*
 * Told only today's offset, a model wrote "last week" in late October with November's -08:00, an
 * hour from the admin's real midnight. The prompt now lists each recent midnight with its own.
 */
test("each recent midnight carries the offset in force that day, across a change of clocks", () => {
  const pacific = recentMidnights(asked);
  expect(pacific[0]).toEqual({
    name: "Monday 9 November",
    iso: "2026-11-09T00:00:00-08:00",
  });
  // US clocks went back at 02:00 on 1 November, so its midnight was still daylight time.
  expect(pacific.find((day) => day.name === "Sunday 1 November")?.iso).toBe(
    "2026-11-01T00:00:00-07:00",
  );
  expect(pacific.at(-1)?.iso).toBe("2026-10-25T00:00:00-07:00");

  // UK clocks went forward at 01:00 on 29 March, after its midnight.
  const london = recentMidnights({
    now: new Date("2026-03-30T10:00:00Z"),
    timeZone: "Europe/London",
  });
  expect(london.slice(0, 2).map((day) => day.iso)).toEqual([
    "2026-03-30T00:00:00+01:00",
    "2026-03-29T00:00:00+00:00",
  ]);
  // East of UTC, the day is the admin's day, not the server's.
  expect(
    recentMidnights({
      now: new Date("2026-11-09T20:00:00Z"),
      timeZone: "Pacific/Auckland",
    })[0]?.iso,
  ).toBe("2026-11-10T00:00:00+13:00");
});

/*
 * FOUND IN THE COMBINED STACK'S REVIEW: "What did the social media rule block today?" read back as
 * "Bot Use the computer refusals refused by Bots may not visit social media sites". The reader was
 * handed `computer.action_refused (Use the computer)`, a row's own words, and told to call the AI a
 * Bot whether or not any filter named one. It is handed the Audit page's words for the kind of row
 * now, and nothing that invites a subject the filters don't name.
 */
/*
 * Given "After: Monday, 9 November…" and "Before: Monday, 9 November…", the reader wrote "from 9
 * November to 9 November". A range inside one local day reaches it as that day, once.
 */
describe("the reading is given a range inside one day as that day once", () => {
  const timeOf = (filters: { from?: string; to?: string }) =>
    describeFilters(
      filters,
      { bots: {}, people: {}, apps: {}, rules: {} },
      "Europe/London",
    );

  test("today so far", () => {
    expect(
      timeOf({ from: "2026-11-09T00:00:00Z", to: "2026-11-09T14:33:00Z" }),
    ).toEqual(["On Monday, 9 November 2026, from 00:00 to 14:33"]);
  });

  test("yesterday, ending at today's midnight", () => {
    expect(
      timeOf({ from: "2026-11-08T00:00:00Z", to: "2026-11-09T00:00:00Z" }),
    ).toEqual(["On Sunday, 8 November 2026, the whole day"]);
  });

  test("the same day in the admin's zone, though not in UTC", () => {
    expect(
      describeFilters(
        { from: "2026-11-09T08:00:00.000Z", to: "2026-11-09T22:00:00.000Z" },
        { bots: {}, people: {}, apps: {}, rules: {} },
        "America/Los_Angeles",
      ),
    ).toEqual(["On Monday, 9 November 2026, from 00:00 to 14:00"]);
  });

  test("a range over several days keeps both ends", () => {
    expect(
      timeOf({ from: "2026-11-02T00:00:00Z", to: "2026-11-09T00:00:00Z" }),
    ).toEqual([
      "After: Monday, 2 November 2026 at 00:00",
      "Before: Monday, 9 November 2026 at 00:00",
    ]);
  });

  test("one end alone is said as that end", () => {
    expect(timeOf({ from: "2026-11-09T09:00:00Z" })).toEqual([
      "After: Monday, 9 November 2026 at 09:00",
    ]);
  });
});

test("the reading is given the kind of row in the Audit page's words, and no Bot the filters don't name", () => {
  const rule = 'intent == "navigate" && contains(page.host, "facebook")';
  const ruleName = "Bots may not visit social media sites";
  const lines = describeFilters(
    {
      eventType: ["computer.action_refused"],
      rule,
      from: "2026-11-09T08:00:00.000Z",
      to: "2026-11-09T22:00:00.000Z",
    },
    { bots: {}, people: {}, apps: {}, rules: { [rule]: ruleName } },
    "America/Los_Angeles",
  );
  expect(lines[0]).toBe("Kind of row, any of: Computer actions, blocked");
  expect(lines[1]).toBe(`By the rule "${ruleName}"`);
  const prompt = readingPrompt(lines, "America/Los_Angeles");
  for (const text of [lines.join("\n"), prompt]) {
    expect(text).not.toContain("Use the computer");
    expect(text).not.toContain("computer.action_refused");
    // The rule's own name says "Bots"; nothing else may bring one in.
    expect(text.replaceAll(ruleName, "")).not.toMatch(/\bBots?\b/);
  }
});
