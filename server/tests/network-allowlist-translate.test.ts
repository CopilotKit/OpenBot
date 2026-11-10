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
import { parseEgressRules } from "../src/computer/policy-network";
import { loadConfig } from "../src/config";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/network-allowlist-recorded.json";
import { testEnvironment } from "./support/environment";

/**
 * An admin describes the network allowlist in English and gets entries back: written by the
 * deployment's model, run through the computer's own parser, sent back once with every entry that
 * didn't parse, and read back by a call that never sees the description.
 *
 * Through the real route in `createApp`, with the model answered by aimock serving answers recorded
 * from the real API to these exact prompts (`fixtures/network-allowlist-recorded.json`).
 */

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
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

type Case = {
  model: string;
  text: string;
  writer: string[];
  reader?: string;
};

/** The writer's attempts in order, then the reader, each matched by what only its prompt carries. */
function serve(recording: Case) {
  const [first, second] = recording.writer;
  if (second) mock.on({ userMessage: /The parser said:/ }, { content: second });
  if (first) mock.on({ userMessage: /<description>/ }, { content: first });
  if (recording.reader)
    mock.on(
      { userMessage: /You explain one OpenBot network allowlist/ },
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
  return app.request(
    "http://localhost:3001/api/admin/enterprise/network/translate",
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

type Written = {
  mode: string;
  entries: { type: string; value: string; ports: string }[];
};

describe("POST /api/admin/enterprise/network/translate", () => {
  test("a description comes back as entries the computer's parser accepts, with hosts the admin didn't name and an independent reading", async () => {
    const recording = recorded.writtenFirstTime;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const written = JSON.parse(recording.writer[0] as string) as Written;
    const reading = JSON.parse(recording.reader);
    // The parser the computer reads a pushed policy with takes every entry, unchanged.
    const parsed = parseEgressRules(body.rules);
    expect(parsed).toEqual({ ok: true, rules: body.rules });
    expect(body).toEqual({
      mode: "allowlist_only",
      rules: written.entries.map(({ type, value }) => ({ type, value })),
      summary: reading.summary,
      reachable: reading.reachable,
      explanation: reading.explanation,
      check: { ok: true },
      warning: null,
    });
    // "Salesforce and Google Workspace" names two services. The list covers the hosts an admin
    // would miss, from the vendors' published lists.
    const values = body.rules.map((rule: { value: string }) => rule.value);
    for (const host of [
      "salesforce.com",
      "force.com",
      "visualforce.com",
      "google.com",
      "googleapis.com",
      "gstatic.com",
      "googleusercontent.com",
    ])
      expect(values).toContain(host);

    // One list, then one reading of it. The reading was asked with the entries and never the request.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    expect(asked[1]).toContain("domain force.com");
    expect(asked[1]).toContain('mode is "allowlist_only"');
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("<description>");

    // Structured output, held to the list's own schema.
    const firstBody = mock.getRequests()[0]?.body as {
      response_format?: unknown;
    };
    expect(firstBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "network_allowlist", strict: true },
    });

    expect(audit).toEqual([
      {
        eventType: "network_policy.translated",
        targetType: "network_policy",
        actorUserId: ADMIN.id,
        payload: {
          actor: ADMIN.email,
          text: recording.text,
          outcome: "written",
          mode: "allowlist_only",
          rules: body.rules,
          summary: reading.summary,
          reachable: reading.reachable,
          explanation: reading.explanation,
          warning: null,
          parsed: true,
          attempts: 1,
        },
      },
    ]);
  });

  test("an entry the parser refuses is sent back with the parser's words, and the corrected list is returned with a reading of what it now says", async () => {
    const recording = recorded.fixedOnRetry;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const first = JSON.parse(recording.writer[0] as string) as Written;
    const second = JSON.parse(recording.writer[1] as string) as Written;
    // The first answer copied a host name with an underscore, which the computer's parser refuses.
    const refused = first.entries.find((entry) => entry.value.includes("_"));
    expect(refused?.value).toBe("my_tools.corp.example");
    expect(
      parseEgressRules([{ type: "domain", value: refused?.value }]),
    ).toEqual({ ok: false, error: '"my_tools.corp.example" is not a domain.' });
    expect(body.check).toEqual({ ok: true });
    expect(body.rules).toEqual(
      second.entries.map(({ type, value }) => ({ type, value })),
    );
    expect(body.reachable).toEqual(JSON.parse(recording.reader).reachable);

    const asked = prompts();
    expect(asked).toHaveLength(3);
    // The second attempt carries the list as written and what the parser said about it.
    expect(asked[1]).toContain("domain my_tools.corp.example");
    expect(asked[1]).toContain('"my_tools.corp.example" is not a domain.');
    // The model "fixed" it by writing a different host. The reading, which never saw the request,
    // names the host the list now holds, so the drift is on screen beside the admin's words.
    expect(asked[2]).toContain("domain my-tools.corp.example");
    expect(asked[2]).not.toContain(recording.text);
    expect(body.reachable.join(" ")).toContain("my-tools.corp.example");

    expect(audit[0]?.payload).toMatchObject({
      outcome: "written",
      parsed: true,
      attempts: 2,
    });
  });

  test("a list that never parses is returned with every entry that failed, unexplained, after two attempts", async () => {
    const recording = recorded.neverParses;
    serve(recording);
    const { app, audit } = appFor({ model: recording.model });

    const response = await translate(app, recording.text);

    expect(response.status).toBe(200);
    const body = await response.json();
    const problems = [
      '"db_primary.corp.example" is not a domain.',
      '"db_replica.corp.example" is not a domain.',
    ];
    expect(body).toEqual({
      mode: "allowlist_only",
      rules: [
        { type: "domain", value: "db_primary.corp.example" },
        { type: "domain", value: "db_replica.corp.example" },
      ],
      summary: null,
      reachable: [],
      explanation: null,
      check: {
        ok: false,
        error: `2 entries don't parse. ${problems.join(" ")}`,
        problems,
      },
      warning: null,
    });
    // Both entries were named to the model, not only the first the parser met.
    expect(prompts()[1]).toContain(problems[0] as string);
    expect(prompts()[1]).toContain(problems[1] as string);
    // Two writes and no reading: a list that does not parse is not explained as though it worked.
    expect(prompts()).toHaveLength(2);
    expect(audit[0]?.payload).toMatchObject({
      outcome: "did_not_parse",
      parsed: false,
      attempts: 2,
      error: body.check.error,
    });
  });

  test("with no model set up it says one is needed, asks nothing, and records the request", async () => {
    const { app, audit } = appFor({ key: null });

    const response = await translate(app, "Only Salesforce");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "OpenBot needs a model key to write a list from a description. Add one on the Credentials page, or type the list yourself.",
    });
    expect(mock.getRequests()).toHaveLength(0);
    expect(audit.map((event) => event.payload)).toEqual([
      { actor: ADMIN.email, text: "Only Salesforce", outcome: "no_model" },
    ]);
  });

  test("only an admin can ask, and the model is never called for anybody else", async () => {
    const { app, audit } = appFor({ role: "user" });

    const response = await translate(app, "Only Salesforce");

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
        error: "Describe where Bots may connect in a sentence first.",
      });
      expect(mock.getRequests()).toHaveLength(0);
    },
  );
});
