import { describe, expect, test } from "bun:test";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createHostAccessBroker } from "../src/host-access/broker";
import { hostAccessTools } from "../src/host-access/tools";
import { testEnvironment } from "./support/environment";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function appWithHostDispatcher(
  broker: ReturnType<typeof createHostAccessBroker>,
) {
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
      if (!tool) return { text: "not available", isError: true };
      const text = await tool.execute(args);
      return { text, isError: false };
    },
  );
}

describe("host access tools on the signed agent callback route", () => {
  test("dispatches host_read_file through the broker as the signed Bot and actor", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();
    const app = appWithHostDispatcher(broker);

    const responsePromise = app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": "legacy-agent-tool-token",
      },
      body: JSON.stringify({
        name: "host_read_file",
        args: { grantId: "grant-1", path: "notes.txt" },
        // These must be ignored. The signed run below is the only identity source.
        botId: "bot-b",
        actorId: "user-b",
        run: mintRunAssertion(
          { botId: "bot-a", actorId: "user-a", runId: "run-a" },
          KEY,
        ),
      }),
    });
    let lease = null as ReturnType<typeof broker.nextDesktopOperation>;
    for (let attempt = 0; attempt < 20; attempt++) {
      lease = broker.nextDesktopOperation();
      if (lease?.operations[0]) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lease?.operations[0]).toMatchObject({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      result: { content: "hello" },
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: JSON.stringify({ content: "hello" }),
      isError: false,
    });
  });
});
