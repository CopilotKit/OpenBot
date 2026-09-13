import { describe, expect, test } from "bun:test";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "../src/host-access/broker";
import type { HostAccessDesktopOperation } from "../src/host-access/schema";

describe("host access broker", () => {
  test("a folder grant request queues a native picker operation and stores only the returned opaque grant", async () => {
    const broker = createHostAccessBroker();

    const pending = broker.requestFolderGrant({
      botId: "bot-a",
      botName: "Research Bot",
      actorId: "user-a",
    });

    const lease = broker.nextDesktopOperation();
    expect(lease?.operations[0]).toMatchObject({
      kind: "choose_folder",
      botId: "bot-a",
      botName: "Research Bot",
      actorId: "user-a",
      writable: false,
    });

    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      grant: {
        grantId: "native-grant-1",
        displayName: "Project",
        writable: false,
      },
    });

    await expect(pending).resolves.toEqual({
      id: "native-grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    expect(broker.statusFor("user-a").grants).toEqual([
      {
        id: "native-grant-1",
        botId: "bot-a",
        actorId: "user-a",
        displayName: "Project",
        revoked: false,
      },
    ]);
  });

  test("host operations are tied to the selected Bot and actor", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });

    await expect(
      broker.callHost({
        kind: "list_files",
        botId: "bot-b",
        actorId: "user-a",
        grantId: "grant-1",
        relativePath: ".",
      }),
    ).rejects.toBeInstanceOf(HostAccessRefusedError);
    await expect(
      broker.callHost({
        kind: "list_files",
        botId: "bot-a",
        actorId: "user-b",
        grantId: "grant-1",
        relativePath: ".",
      }),
    ).rejects.toBeInstanceOf(HostAccessRefusedError);
  });

  test("read-only folder grants still dispatch writes and commands for native per-operation confirmation", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });

    const write = broker.callHost({
      kind: "write_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
      content: "draft",
    });
    const writeLease = broker.nextDesktopOperation();
    expect(writeLease?.operations[0]).toMatchObject({
      kind: "write_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
      content: "draft",
    });
    broker.resolveDesktopOperation({
      operationId: writeLease!.operations[0]!.operationId,
      ok: true,
      result: { written: true },
    });
    await expect(write).resolves.toEqual({ written: true });

    const command = broker.callHost({
      kind: "run_command",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      command: "pwd",
    });
    const commandLease = broker.nextDesktopOperation();
    expect(commandLease?.operations[0]).toMatchObject({
      kind: "run_command",
      command: "pwd",
    });
    broker.resolveDesktopOperation({
      operationId: commandLease!.operations[0]!.operationId,
      ok: true,
      result: { stdout: "/workspace" },
    });
    await expect(command).resolves.toEqual({ stdout: "/workspace" });
  });

  test("revoking a grant rejects queued and inflight calls and queues native cancellation", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });

    const queued = broker.callHost({
      kind: "list_files",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: ".",
    });
    const inflight = broker.callHost({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });
    const lease = broker.nextDesktopOperation();
    expect(lease?.operations[0]).toMatchObject({
      kind: "list_files",
    } satisfies Partial<HostAccessDesktopOperation>);

    broker.revokeGrant("grant-1", "user-a");
    const rejected = await Promise.allSettled([queued, inflight]);
    expect(rejected.map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(
      rejected.map((entry) =>
        entry.status === "rejected" && entry.reason instanceof Error
          ? entry.reason.message
          : "",
      ),
    ).toEqual([
      "That folder grant was revoked before the operation finished.",
      "That folder grant was revoked before the operation finished.",
    ]);

    const firstCancel = broker.nextDesktopOperation()?.operations[0];
    const secondCancel = broker.nextDesktopOperation()?.operations[0];
    expect([firstCancel?.kind, secondCancel?.kind]).toEqual([
      "cancel",
      "cancel",
    ]);
    expect(broker.statusFor("user-a").grants[0]?.revoked).toBe(true);
  });

  test("stale or replayed desktop results cannot recreate grants or finish cancelled operations", async () => {
    const broker = createHostAccessBroker();
    const pending = broker.requestFolderGrant({
      botId: "bot-a",
      botName: "Bot A",
      actorId: "user-a",
    });
    const lease = broker.nextDesktopOperation();
    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: false,
      error: "cancelled",
    });
    await expect(pending).rejects.toThrow("cancelled");

    broker.resolveDesktopOperation({
      operationId: lease!.operations[0]!.operationId,
      ok: true,
      grant: { grantId: "grant-late", displayName: "Late" },
    });
    expect(broker.statusFor("user-a").grants).toEqual([]);
  });

  test("desktop lease expiry marks offline, revokes grants, rejects operations, and returns cancellation on reconnect", async () => {
    let clock = 1_000;
    const broker = createHostAccessBroker(() => clock);
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    const running = broker.callHost({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "read_file",
    });
    expect(broker.statusFor("user-a").connected).toBe(true);

    clock += 15_001;
    expect(broker.statusFor("user-a").connected).toBe(false);
    const disconnected = await Promise.allSettled([running]);
    expect(disconnected[0]?.status).toBe("rejected");
    expect(
      disconnected[0]?.status === "rejected" &&
        disconnected[0].reason instanceof Error
        ? disconnected[0].reason.message
        : "",
    ).toContain("disconnected");
    expect(broker.statusFor("user-a").grants[0]?.revoked).toBe(true);
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "cancel",
      grantId: "grant-1",
    });
  });

  test("desktop lease expiry autonomously rejects inflight calls without another broker read", async () => {
    const broker = createHostAccessBroker(Date.now, {
      desktopLeaseMs: 10,
      operationTtlMs: 1_000,
    });
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    const running = broker.callHost({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "read_file",
    });

    await expect(running).rejects.toThrow("disconnected");
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "cancel",
      grantId: "grant-1",
    });
  });

  test("host approval operations expire autonomously and cannot execute stale native results", async () => {
    const broker = createHostAccessBroker(Date.now, {
      desktopLeaseMs: 1_000,
      operationTtlMs: 10,
    });
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    const pending = broker.callHost({
      kind: "write_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
      content: "draft",
    });
    const lease = broker.nextDesktopOperation();
    const operation = lease!.operations[0]!;
    expect(operation).toMatchObject({
      kind: "write_file",
      grantId: "grant-1",
    });
    expect(typeof operation.expiresAt).toBe("number");
    expect(operation.expiresAt! - Date.now()).toBeLessThanOrEqual(10);

    await expect(pending).rejects.toThrow("expired");
    broker.resolveDesktopOperation({
      operationId: operation.operationId,
      ok: true,
      result: { written: true },
    });
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "cancel",
      grantId: "grant-1",
    });
  });

  test("Stop revokes all owner grants, cancels outstanding calls, and queues native stop", async () => {
    const broker = createHostAccessBroker();
    broker.rememberGrant({
      id: "grant-1",
      botId: "bot-a",
      actorId: "user-a",
      displayName: "Project",
      revoked: false,
    });
    const running = broker.callHost({
      kind: "read_file",
      botId: "bot-a",
      actorId: "user-a",
      grantId: "grant-1",
      relativePath: "notes.txt",
    });

    broker.stop("user-a");
    const stopped = await Promise.allSettled([running]);
    expect(stopped[0]?.status).toBe("rejected");
    expect(
      stopped[0]?.status === "rejected" && stopped[0].reason instanceof Error
        ? stopped[0].reason.message
        : "",
    ).toContain("stopped");
    expect(broker.statusFor("user-a").grants[0]?.revoked).toBe(true);
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "cancel",
    });
    expect(broker.nextDesktopOperation()?.operations[0]).toMatchObject({
      kind: "stop",
      actorId: "user-a",
    });
  });
});
