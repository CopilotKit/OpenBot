import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AuditEventInput } from "../src/audit";
import { createHostAccessBroker } from "../src/host-access/broker";
import { DENIED_ON_DESKTOP, hostAccessTools } from "../src/host-access/tools";
import { REFUSAL_MARKER } from "../src/plugins/tools";

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

  test("host operations are recorded as a computer's actions, naming the file and never its content", async () => {
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

    // One row, written as it went to the desktop; a success adds nothing to it.
    expect(events.map((event) => event.eventType)).toEqual([
      "computer.action_allowed",
    ]);
    expect(JSON.stringify(events)).not.toContain("do not log");
    expect(events[0]).toMatchObject({
      eventType: "computer.action_allowed",
      targetType: "host_access",
      targetId: "grant-1",
      actorUserId: "user-a",
      initiator: { kind: "handoff", id: "run-1" },
      payload: {
        action: "host/write_file",
        bot: "bot-a",
        grant: "grant-1",
        file: "secret.txt",
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
    // The team edition: an admin chooses a Bot's folders, on Admin → Computers.
    const reason =
      "This Bot has no folders it can read right now. Folder access ends when OpenBot stops. An admin gives a Bot a folder with Choose folder in Admin → Computers.";
    expect(text).toBe(`${REFUSAL_MARKER} ${reason}`);
    expect(events.at(-1)).toMatchObject({
      eventType: "computer.action_refused",
      payload: { action: "host/list_folders", reason },
    });
  });
  /*
   * The desktop's Deny now says "Declined in OpenBot Desktop." where it said "The local owner denied
   * this operation.", which the person read about themselves. The server reads that sentence to
   * record the refusal as the person's own, so Activity says they declined it; a sentence it did
   * not know would have recorded an ordinary refusal.
   */
  test("a Deny on the desktop is recorded as the person declining, in the desktop's words", async () => {
    const source = readFileSync(
      new URL(
        "../../desktop/src-tauri/src/desktop_host_access.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const declined = source.match(/const DECLINED: &str = "([^"]+)";/)?.[1];
    expect(declined).toBe("Declined in OpenBot Desktop.");
    expect(DENIED_ON_DESKTOP.has(declined as string)).toBe(true);

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
    }).find((tool) => tool.name === "host_write_file")!;
    const answer = writeTool.execute({
      grantId: "grant-1",
      path: "todo.txt",
      content: "pick up dry cleaning",
    });
    let lease = broker.nextDesktopOperation();
    for (let index = 0; index < 5 && !lease; index++) {
      await Promise.resolve();
      lease = broker.nextDesktopOperation();
    }
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: false,
      error: declined as string,
    });

    expect(await answer).toBe(`Refused. ${declined}`);
    expect(events.at(-1)).toMatchObject({
      eventType: "computer.action_refused",
      payload: {
        action: "host/write_file",
        file: "todo.txt",
        refusal: "person_declined",
      },
    });
  });
});
