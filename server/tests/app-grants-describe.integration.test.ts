import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { PluginRefusedError } from "../src/plugins/plugin-store/model";
import { createPluginStore } from "../src/plugins/store";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/app-grants-recorded.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { GMAIL_APP_ID, gmailTools } from "./support/gmail-grant-app";

/**
 * An admin describes what one Bot may do in Gmail, and the Bot's app page turns it into an exact set
 * of Gmail's actions: chosen by the deployment's model from the app's own list, checked, read back by
 * a call that never sees the sentence, replayed over the Bot's own app calls, and saved through the
 * grants path every switch on the page uses, with the sentence on the trail.
 *
 * Real tables, the real routes in `createApp`, the real audit store and reader. The Bot's history is
 * made by the real plugin store's `callTool`, so the rows replayed are the rows it writes; only the
 * vendor is a seam. The model is answered by aimock with answers recorded from the real API to these
 * prompts (`fixtures/app-grants-recorded.json`), over Composio's own Gmail listing.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const auditReader = createAuditReader(database);
const suite = randomUUID().slice(0, 8);
const APP = GMAIL_APP_ID;
const BOT = `agent_grants-${suite}`;
const ADMIN = {
  id: `grants-admin-${suite}`,
  email: `grants-admin-${suite}@example.test`,
  name: "An Administrator",
  image: null,
};
const MEMBER = {
  id: `grants-member-${suite}`,
  email: `grants-member-${suite}@example.test`,
  name: "A Member",
  image: null,
};
const ref = (name: string) => `${APP}/${name}`;

const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async () => ({ text: "done", isError: false }),
});

/** One call as the Bot makes it, through the real store: the grant, the policy and the row. */
const call = (name: string) =>
  plugins
    .callTool({ ref: ref(name), args: {}, botId: BOT, actorId: ADMIN.id })
    .then(
      () => "called",
      (error: unknown) =>
        error instanceof PluginRefusedError ? "refused" : Promise.reject(error),
    );

const mock = new LLMock();
const originalBaseUrl = process.env.OPENAI_BASE_URL;

/** What the Bot held before anybody described anything: a send, a delete and a trash among them. */
const HELD = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_SEND_EMAIL",
  "GMAIL_DELETE_MESSAGE",
  "GMAIL_MOVE_TO_TRASH",
];

async function clear() {
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.delete(agents).where(eq(agents.id, BOT));
}

beforeAll(async () => {
  process.env.OPENAI_BASE_URL = await mock.start();
  await clear();
  await database.insert(mcpServers).values({
    id: APP,
    title: "Gmail",
    vendor: "Google",
    url: "https://gmail.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values(
    gmailTools.map((tool) => ({
      serverId: APP,
      name: tool.name,
      vendorName: tool.name,
      description: tool.description,
      inputSchema: {},
      effect: tool.effect,
      destructive: tool.destructive,
    })),
  );
  await database.insert(agents).values({
    id: BOT,
    name: "Inbox Helper",
    type: "built_in",
    configuration: {},
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    title: "Inbox Helper",
    roleDescription: "",
    avatarSeed: BOT,
    visibility: "public",
  });
  await database.insert(pluginGrants).values(
    HELD.map((name) => ({
      kind: "mcp" as const,
      ref: ref(name),
      agentId: BOT,
      grantedBy: ADMIN.email,
    })),
  );

  // What the Bot did with them: read twice, sent once, deleted once, and reached for a draft it
  // didn't have.
  expect(await call("GMAIL_FETCH_EMAILS")).toBe("called");
  expect(await call("GMAIL_FETCH_EMAILS")).toBe("called");
  expect(await call("GMAIL_SEND_EMAIL")).toBe("called");
  expect(await call("GMAIL_DELETE_MESSAGE")).toBe("called");
  expect(await call("GMAIL_CREATE_EMAIL_DRAFT")).toBe("refused");
});

afterEach(() => {
  mock.clearFixtures();
  mock.clearRequests();
});

afterAll(async () => {
  await mock.stop();
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
  // The tools go with the app, the grants with the Bot. Audit rows are append-only and stay; they
  // name only this run's throwaway ids.
  await clear();
  await database.$client.close();
});

type Recording = {
  model: string;
  text: string;
  writer: string[];
  reader?: string;
};

/** The writer's attempts in order, then the reader, each matched by what only its prompt carries. */
function serve(recording: Recording) {
  const [first, second] = recording.writer;
  if (second)
    mock.on({ userMessage: /The checker said:/ }, { content: second });
  if (first) mock.on({ userMessage: /<description>/ }, { content: first });
  if (recording.reader)
    mock.on(
      { userMessage: /You explain to an admin which actions/ },
      { content: recording.reader },
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

function appFor(person: typeof ADMIN, role: "admin" | "user", model: string) {
  const args: never[] = Array.from({ length: 35 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: person }) },
  } as never;
  args[2] = { rolesForUser: async () => [role] } as never;
  args[3] = auditReader as never;
  args[12] = auditStore as never;
  args[14] = plugins as never;
  args[34] = {
    boundaryWriter: createModelCompleter({
      model: { provider: "openai", defaultModel: model },
      resolveApiKey: async () => "test-key",
    }),
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return build(...args);
}

function post(
  path: string,
  body: unknown,
  options: {
    person?: typeof ADMIN;
    role?: "admin" | "user";
    model?: string;
  } = {},
) {
  return appFor(
    options.person ?? ADMIN,
    options.role ?? "admin",
    options.model ?? "gpt-5.6-terra",
  ).request(`http://localhost:3001/api/plugins/for/${BOT}/apps/${APP}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify(body),
  });
}

/** What the Bot holds on Gmail now, by name. */
async function held(): Promise<string[]> {
  const rows = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(eq(pluginGrants.agentId, BOT), like(pluginGrants.ref, `${APP}/%`)),
    );
  return rows.map((row) => row.ref.slice(APP.length + 1)).sort();
}

/** This run's rows of one type, oldest first. */
function rows(eventType: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        sql`${auditEvents.payload} ->> 'bot' = ${BOT}`,
      ),
    )
    .orderBy(auditEvents.createdAt);
}

describe("describing a Bot's actions in one app", () => {
  test("a sentence becomes an exact set of Gmail's actions, read back, replayed over the Bot's own calls, and saved through the grants path with the sentence", async () => {
    const recording = recorded.draftsFirstTime;
    serve(recording);

    // 1. The sentence in, the set out.
    const translated = await post("/grants/translate", {
      text: recording.text,
    });
    expect(translated.status).toBe(200);
    const draft = await translated.json();
    const written = JSON.parse(recording.writer[0] as string) as {
      actions: string[];
    };
    const reading = JSON.parse(recording.reader as string);
    expect(draft).toEqual({
      actions: written.actions,
      grants: written.actions.map(ref),
      otherApps: [],
      summary: reading.summary,
      explanation: reading.explanation,
      check: { ok: true },
      warning: null,
    });
    // Every read, and drafting, and nothing that sends, deletes or trashes.
    const reads = gmailTools.filter((tool) => tool.effect === "read");
    expect(draft.grants).toEqual(
      expect.arrayContaining(reads.map((tool) => ref(tool.name))),
    );
    expect(draft.grants).toEqual(
      expect.arrayContaining([
        ref("GMAIL_CREATE_EMAIL_DRAFT"),
        ref("GMAIL_UPDATE_DRAFT"),
      ]),
    );
    for (const never of [
      "GMAIL_SEND_EMAIL",
      "GMAIL_SEND_DRAFT",
      "GMAIL_FORWARD_MESSAGE",
      "GMAIL_REPLY_TO_THREAD",
      "GMAIL_DELETE_MESSAGE",
      "GMAIL_MOVE_TO_TRASH",
    ])
      expect(draft.grants).not.toContain(ref(never));

    // One choosing, then one reading of it. The reading was asked with the set and never the words.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    expect(asked[0]).toContain("- GMAIL_SEND_EMAIL [write]");
    expect(asked[0]).toContain("- GMAIL_DELETE_MESSAGE [write, destroys]");
    expect(asked[0]).toContain("- GMAIL_FETCH_EMAILS [read]");
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("never sends");
    expect(asked[1]).toContain(`ACTIONS IT GETS (31 of ${gmailTools.length})`);
    expect(asked[1]).toContain("ACTIONS IT DOESN'T GET");
    // Structured output, with Gmail's own names as the only answers a strict provider can give.
    const firstBody = mock.getRequests()[0]?.body as {
      response_format?: {
        json_schema?: {
          name?: string;
          schema?: {
            properties?: { actions?: { items?: { enum?: string[] } } };
          };
        };
      };
    };
    expect(firstBody.response_format?.json_schema?.name).toBe("app_grants");
    expect(
      firstBody.response_format?.json_schema?.schema?.properties?.actions?.items
        ?.enum,
    ).toHaveLength(gmailTools.length);

    const [drafted] = await rows("plugin.grants_translated");
    expect(drafted).toMatchObject({
      actorUserId: ADMIN.id,
      targetType: "mcp_server",
      targetId: APP,
    });
    expect(drafted?.payload).toMatchObject({
      actor: ADMIN.email,
      text: recording.text,
      outcome: "written",
      checked: true,
      attempts: 1,
    });

    // 2. What it would change, against what the Bot holds now and what it did with it.
    const replayed = await post("/grants/replay", { grants: draft.grants });
    expect(replayed.status).toBe(200);
    const { check, warning, changes, report } = await replayed.json();
    expect(check).toEqual({ ok: true });
    expect(warning).toBeNull();
    expect(changes.removed.map((tool: { name: string }) => tool.name)).toEqual([
      "GMAIL_DELETE_MESSAGE",
      "GMAIL_MOVE_TO_TRASH",
      "GMAIL_SEND_EMAIL",
    ]);
    expect(changes.added).toHaveLength(30);
    expect(report).toMatchObject({
      // Four calls made and one refused, each counted once.
      calls: 5,
      callsLost: 2,
      callsGained: 1,
      addedUnusedReads: 28,
    });
    // It takes away the send and the delete the Bot used. The trash it never used isn't listed.
    expect(
      report.removedUsed.map((entry: { name: string; calls: number }) => [
        entry.name,
        entry.calls,
      ]),
    ).toEqual([
      ["GMAIL_DELETE_MESSAGE", 1],
      ["GMAIL_SEND_EMAIL", 1],
    ]);
    // It gives the draft the Bot was refused, and one write it never reached for.
    expect(
      report.refusedGiven.map((entry: { name: string }) => entry.name),
    ).toEqual(["GMAIL_CREATE_EMAIL_DRAFT"]);
    expect(report.addedUnusedWrites).toEqual([
      {
        ref: ref("GMAIL_UPDATE_DRAFT"),
        name: "GMAIL_UPDATE_DRAFT",
        destructive: false,
      },
    ]);

    // 3. The admin saves exactly that change.
    const saved = await post("/grants", {
      add: changes.added.map((tool: { ref: string }) => tool.ref),
      remove: changes.removed.map((tool: { ref: string }) => tool.ref),
      authoring: { source: "english", text: recording.text },
    });
    expect(saved.status).toBe(200);
    expect(await held()).toEqual([...written.actions].sort());

    // Each action on the trail as a switch writes it, and one row saying they were one change.
    const perAction = await rows("configuration.changed");
    expect(
      perAction.filter((row) => row.payload.change === "plugin_granted"),
    ).toHaveLength(30);
    expect(
      perAction
        .filter((row) => row.payload.change === "plugin_revoked")
        .map((row) => row.targetId)
        .sort(),
    ).toEqual(changes.removed.map((tool: { ref: string }) => tool.ref).sort());
    const [change] = await rows("plugin.grants_changed");
    expect(change).toMatchObject({
      actorUserId: ADMIN.id,
      targetType: "mcp_server",
      targetId: APP,
    });
    expect(change?.payload).toMatchObject({
      actor: ADMIN.email,
      app: APP,
      bot: BOT,
      removed: changes.removed.map((tool: { ref: string }) => tool.ref),
      authoring: { source: "english", text: recording.text },
    });
    expect(change?.payload.added).toHaveLength(30);

    // And the Bot is held to it on its next call: drafting works, sending is refused.
    expect(await call("GMAIL_CREATE_EMAIL_DRAFT")).toBe("called");
    expect(await call("GMAIL_SEND_EMAIL")).toBe("refused");
  });

  test("names Gmail doesn't have are sent back with what is wrong, and another app the sentence names is read out, not guessed at", async () => {
    const retry = recorded.fixedOnRetry;
    serve(retry);
    const fixed = await post(
      "/grants/translate",
      { text: retry.text },
      { model: retry.model },
    );
    expect(fixed.status).toBe(200);
    const body = await fixed.json();
    const first = JSON.parse(retry.writer[0] as string).actions as string[];
    expect(first).toContain("GMAIL_ARCHIVE_THREAD");
    expect(body.check).toEqual({ ok: true });
    expect(body.grants).toEqual(
      JSON.parse(retry.writer[1] as string).actions.map(ref),
    );
    const asked = prompts();
    expect(asked).toHaveLength(3);
    // The second attempt carried the first answer and the checker's own words.
    expect(asked[1]).toContain('"GMAIL_ARCHIVE_THREAD"');
    expect(asked[1]).toContain(
      '"GMAIL_ARCHIVE_THREAD" isn\'t an action Gmail offers.',
    );
    expect(asked[1]).toContain(
      '"GMAIL_STAR_MESSAGE" isn\'t an action Gmail offers.',
    );
    const retried = (await rows("plugin.grants_translated")).at(-1);
    expect(retried?.payload).toMatchObject({ outcome: "written", attempts: 2 });

    mock.clearFixtures();
    mock.clearRequests();
    const other = recorded.otherAppNamed;
    serve(other);
    const named = await post("/grants/translate", { text: other.text });
    expect(named.status).toBe(200);
    const read = await named.json();
    expect(read.otherApps).toEqual(["Salesforce"]);
    expect(read.explanation).toContain("Salesforce");
    const [, readerPrompt] = prompts();
    expect(readerPrompt).toContain(
      "OTHER APPS: the request also named Salesforce",
    );
    expect(readerPrompt).not.toContain(other.text);
  });

  test("the save is held to today's checks: somebody who isn't an admin can't take actions away, and nothing changes", async () => {
    const before = await held();

    const refused = await post(
      "/grants",
      { add: [], remove: [ref("GMAIL_FETCH_EMAILS")] },
      { person: MEMBER, role: "user" },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only an admin can choose which Bots use a tool.",
      problems: [
        {
          ref: ref("GMAIL_FETCH_EMAILS"),
          error: "Only an admin can choose which Bots use a tool.",
        },
      ],
    });
    // Describing is an admin's too, and the model is never asked for anybody else.
    const asked = await post(
      "/grants/translate",
      { text: "Reads Gmail" },
      { person: MEMBER, role: "user" },
    );
    expect(asked.status).toBe(403);
    expect(mock.getRequests()).toHaveLength(0);
    // An action the app doesn't offer is refused at the save, as the check refuses it.
    const unknown = await post("/grants", {
      add: [ref("GMAIL_SEND_FAX")],
      remove: [],
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe(
      `${ref("GMAIL_SEND_FAX")} isn't an action this app offers now.`,
    );
    expect(await held()).toEqual(before);
    expect(
      await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "plugin.grants_changed"),
            inArray(auditEvents.actorUserId, [MEMBER.id]),
          ),
        ),
    ).toEqual([]);
  });
});
