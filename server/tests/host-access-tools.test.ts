import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { createHostAccessBroker } from "../src/host-access/broker";
import { hostAccessTools } from "../src/host-access/tools";

function auditRecorder() {
  const events: AuditEventInput[] = [];
  return {
    events,
    auditStore: {
      insert: async (event: AuditEventInput) => {
        events.push(event);
      },
    },
  };
}

describe("host access tools", () => {
  test("offer folder discovery so the model does not need copied grant ids", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });

    const tools = hostAccessTools({
      broker,
      botId: "bot-a",
      actorId: "user-a",
    });
    expect(tools.map((tool) => tool.name)).toEqual(["host_list_folders"]);
    expect(await tools[0]!.execute({})).toContain("Project");
    expect(await tools[0]!.execute({})).toContain("grant-1");
  });

  test("hides file and command operations while desktop is offline", () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });

    expect(
      hostAccessTools({ broker, botId: "bot-a", actorId: "user-a" }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["host_list_folders"]);
  });

  test("server-side tools are bound to one selected Bot and actor once desktop is connected", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();

    const tools = hostAccessTools({
      broker,
      botId: "bot-a",
      actorId: "user-a",
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "host_list_folders",
      "host_list_files",
      "host_read_file",
      "host_write_file",
      "host_run_command",
    ]);

    const answer = tools[1]!.execute({ grantId: "grant-1", path: "." });
    await Promise.resolve();
    const lease = broker.nextDesktopOperation();
    expect(lease?.operations[0]).toMatchObject({
      kind: "list_files",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: ".",
    });
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      result: { entries: [{ name: "notes.txt", kind: "file" }] },
    });
    expect(await answer).toContain("notes.txt");

    const otherBotTools = hostAccessTools({
      broker,
      botId: "bot-b",
      actorId: "user-a",
    });
    expect(otherBotTools.map((tool) => tool.name)).toEqual([
      "host_list_folders",
    ]);
    expect(await otherBotTools[0]!.execute({})).not.toContain("grant-1");
  });

  test("run commands carry working folder and writable intent to native and still require native approval", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();
    const commandTool = hostAccessTools({
      broker,
      botId: "bot-a",
      actorId: "user-a",
    }).find((tool) => tool.name === "host_run_command")!;

    const answer = commandTool.execute({
      grantId: "grant-1",
      path: "scripts",
      command: "npm test",
      writable: true,
    });
    await Promise.resolve();
    const lease = broker.nextDesktopOperation();
    expect(lease?.operations[0]).toMatchObject({
      kind: "run_command",
      relativePath: "scripts",
      command: "npm test",
      writable: true,
    });
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      result: { stdout: "ok" },
    });
    expect(await answer).toContain("ok");
  });

  test("host operations audit request and outcome without content command or raw path", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();
    const { auditStore, events } = auditRecorder();
    const writeTool = hostAccessTools({
      broker,
      botId: "bot-a",
      actorId: "user-a",
      auditStore,
      initiator: { kind: "handoff", id: "run-1" },
    }).find((tool) => tool.name === "host_write_file")!;

    const answer = writeTool.execute({
      grantId: "grant-1",
      path: "secret.txt",
      content: "do not log",
    });
    let lease = broker.nextDesktopOperation();
    for (let index = 0; index < 5 && !lease; index++) {
      await Promise.resolve();
      lease = broker.nextDesktopOperation();
    }
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      result: { written: true },
    });
    await answer;

    expect(events.map((event) => event.payload.outcome)).toEqual([
      "requested",
      "succeeded",
    ]);
    expect(JSON.stringify(events)).not.toContain("do not log");
    expect(JSON.stringify(events)).not.toContain("secret.txt");
    expect(events[0]).toMatchObject({
      eventType: "configuration.changed",
      targetType: "host_access",
      targetId: "grant-1",
      actorUserId: "user-a",
      initiator: { kind: "handoff", id: "run-1" },
      payload: {
        change: "host_access_tool_call",
        operation: "write_file",
        bot: "bot-a",
        grant: "grant-1",
        outcome: "requested",
      },
    });
  });

  test("denied host operations are audited as refusals", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    broker.nextDesktopOperation();
    const { auditStore, events } = auditRecorder();
    const tool = hostAccessTools({
      broker,
      botId: "bot-b",
      actorId: "user-a",
      auditStore,
    }).find((candidate) => candidate.name === "host_read_file");

    expect(tool).toBeUndefined();
    const list = hostAccessTools({
      broker,
      botId: "bot-b",
      actorId: "user-a",
      auditStore,
    })[0]!;
    const text = await list.execute({});
    expect(text).toContain("No host folders");
    expect(events.at(-1)?.payload).toMatchObject({
      operation: "list_folders",
      outcome: "refused",
    });
  });
});
