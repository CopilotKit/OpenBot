import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  type EnterpriseControls,
  guardHostAccess,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseGate } from "../src/admin/gate";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { setEdition } from "../src/edition";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "../src/host-access/broker";
import {
  createHostAccessRoutes,
  NO_DESKTOP_HOST,
} from "../src/host-access/routes";
import { hostAccessTools } from "../src/host-access/tools";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Folders on the person's own machine in the personal edition, which OpenBot Desktop installs.
 *
 * Through the real enterprise controls, because both refusals the desktop showed came from them: the
 * gate in front of `POST /api/host-access/grants` and the guard around the broker
 * (`guardHostAccess`), each asking `resolveCapability` for "Local computer access". Without installed
 * controls both let everything through, so a test without them would pass with the switch off.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const person = {
  id: `personal-folders-${randomUUID().slice(0, 8)}`,
  email: "dev@openbot.local",
  role: "admin" as const,
};
const bot = "personal-assistant";
let controls: EnterpriseControls;

beforeAll(async () => {
  setEdition("personal");
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    env: {},
  });
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  setEdition("team");
  await controls?.stop();
  await database.$client.end({ timeout: 5 });
});

/** The broker as `index.ts` builds it: guarded by the person's "Local computer access". */
function guardedBroker() {
  return guardHostAccess(
    createHostAccessBroker(),
    (message) => new HostAccessRefusedError(message),
  );
}

/** The folder routes behind the enterprise gate, as `app.ts` mounts them. */
function folderRoutes(
  broker: ReturnType<typeof createHostAccessBroker>,
  desktopToken: string | undefined,
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", person);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/api/*", createEnterpriseGate(requireUser));
  app.route(
    "/api/host-access",
    createHostAccessRoutes({
      broker,
      desktopToken,
      requireUser,
      canUseBot: async (_actor, botId) => botId === bot,
      botName: async () => "Personal Assistant",
    }),
  );
  return app;
}

/** The signed callback a Bot's tool call arrives on, dispatching `host_*` as `index.ts` does. */
function callbackApp(broker: ReturnType<typeof createHostAccessBroker>) {
  return createApp(
    loadConfig(
      testEnvironment({
        AGENT_TOOL_TOKEN: "legacy-agent-tool-token",
        KEY_ENCRYPTION_KEY: KEY,
      }),
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    broker,
    "desktop-token",
    async ({ name, args, botId, actorId, initiator }) => {
      if (!name.startsWith("host_")) return null;
      const tool = hostAccessTools({ broker, botId, actorId, initiator }).find(
        (candidate) => candidate.name === name,
      );
      if (!tool)
        return {
          text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
          isError: true,
        };
      const text = await tool.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    },
  );
}

/** What the desktop's worker does: poll until the server hands it an operation. */
async function nextOperation(
  broker: ReturnType<typeof createHostAccessBroker>,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lease = broker.nextDesktopOperation();
    const operation = lease?.operations[0];
    if (operation) return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the desktop was never handed an operation");
}

describe("the personal edition with OpenBot Desktop", () => {
  test("choosing a folder reaches the desktop's picker and comes back granted", async () => {
    setEdition("personal");
    const broker = guardedBroker();
    broker.nextDesktopOperation();
    const app = folderRoutes(broker, "desktop-token");

    const response = app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: bot }),
      headers: { "content-type": "application/json" },
    });
    const operation = await nextOperation(broker);
    expect(operation).toMatchObject({
      kind: "choose_folder",
      botId: bot,
      botName: "Personal Assistant",
      actorId: person.id,
      writable: false,
    });
    broker.resolveDesktopOperation({
      operationId: operation.operationId,
      ok: true,
      grant: { grantId: "grant-notes", displayName: "Notes" },
    });

    const answered = await response;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      grant: { id: "grant-notes", botId: bot, displayName: "Notes" },
    });
  });

  test("a Bot reads a file in the granted folder through the signed callback", async () => {
    setEdition("personal");
    const broker = guardedBroker();
    broker.rememberGrant({
      id: "grant-notes",
      botId: bot,
      actorId: person.id,
      displayName: "Notes",
      revoked: false,
    });
    broker.nextDesktopOperation();

    const response = callbackApp(broker).request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": "legacy-agent-tool-token",
      },
      body: JSON.stringify({
        name: "host_read_file",
        args: { grantId: "grant-notes", path: "todo.txt" },
        run: mintRunAssertion(
          { botId: bot, actorId: person.id, runId: "run-notes" },
          KEY,
        ),
      }),
    });
    const operation = await nextOperation(broker);
    expect(operation).toMatchObject({
      kind: "read_file",
      grantId: "grant-notes",
      relativePath: "todo.txt",
    });
    broker.resolveDesktopOperation({
      operationId: operation.operationId,
      ok: true,
      result: { content: "buy milk" },
    });

    const answered = await response;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      text: JSON.stringify({ content: "buy milk" }),
      isError: false,
    });
  });
});

describe("the personal edition without OpenBot Desktop", () => {
  test("choosing a folder is refused at once, saying the desktop is what's missing", async () => {
    setEdition("personal");
    const broker = guardedBroker();
    const app = folderRoutes(broker, undefined);

    const status = await (await app.request("/api/host-access")).json();
    expect(status).toMatchObject({ desktop: false, connected: false });

    const response = await app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: bot }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_DESKTOP_HOST });
    expect(broker.statusFor(person.id).pending).toEqual([]);
  });

  /*
   * Found on Windows: a folder given to a Bot, then OpenBot restarted. The step read "No host folders
   * are granted to this Bot." and the Bot told the person "an administrator can restore the folder
   * grant". There is no administrator here: the person chooses the folder again themselves.
   */
  test("after OpenBot restarts, the Bot says it has no folders and how the person gives it one", async () => {
    setEdition("personal");
    const before = guardedBroker();
    before.rememberGrant({
      id: "grant-share",
      botId: bot,
      actorId: person.id,
      displayName: "share",
      revoked: false,
    });
    const listed = await hostAccessTools({
      broker: before,
      botId: bot,
      actorId: person.id,
    })[0]?.execute({});
    expect(listed).toContain('"displayName":"share"');
    // OpenBot stops and starts again: a new broker, with none of the old session's folders.
    const tools = hostAccessTools({
      broker: guardedBroker(),
      botId: bot,
      actorId: person.id,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["host_list_folders"]);
    const text = await tools[0]?.execute({});
    expect(text).toBe(
      `${REFUSAL_MARKER} This Bot has no folders it can read right now. Folder access ends when you stop OpenBot. To give it a folder, use Choose folder in Settings → Computer.`,
    );
    expect(text).not.toMatch(/administrator|host|grant/i);
  });
});
