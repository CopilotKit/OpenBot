import { describe, expect, test } from "bun:test";
import {
  CommandResult,
  canonicalCommand,
  Heartbeat,
  HeartbeatReply,
  HeartbeatReplyWire,
  readCommands,
  releaseManifestDigest,
  signCommand,
  toBase64,
  type UnsignedCommand,
} from "../management-contract";

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey: toBase64(raw) };
}

const now = new Date("2026-11-18T12:00:00Z");
function command(overrides: Partial<UnsignedCommand> = {}): UnsignedCommand {
  return {
    id: "cmd-1",
    kind: "restart",
    args: { workload: "server", order: [2, 1] },
    issuedAt: "2026-11-18T11:59:00Z",
    expiresAt: "2026-11-18T12:30:00Z",
    ...overrides,
  };
}

const heartbeat = {
  installId: "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11",
  agentVersion: "0.1.0",
  cloud: "aws",
  openbot: {
    version: "v1.1.0",
    chartVersion: "1.1.0",
    imageDigests: { server: `sha256:${"a".repeat(64)}` },
  },
  intelligence: { chartVersion: "0.16.0" },
  lastAppliedMigration: "0132_bot_task_runs",
  flux: {
    helmReleases: [
      {
        name: "openbot",
        ready: true,
        reason: "UpgradeSucceeded",
        message: "Helm upgrade succeeded",
        lastAppliedRevision: "1.1.0",
      },
    ],
  },
  pods: [{ workload: "openbot-server", ready: 2, desired: 2 }],
  upgrade: { state: "idle", targetVersion: null, journal: null },
  sentAt: "2026-11-18T12:00:00.000Z",
};

describe("management contract", () => {
  test("a heartbeat with only the listed fields parses, and any other field is refused", () => {
    expect(Heartbeat.parse(heartbeat)).toEqual(heartbeat as never);
    expect(
      Heartbeat.safeParse({ ...heartbeat, hostname: "db.internal" }).success,
    ).toBe(false);
    expect(
      Heartbeat.safeParse({
        ...heartbeat,
        openbot: { ...heartbeat.openbot, customer: "x" },
      }).success,
    ).toBe(false);
  });

  test("a window shorter than four hours is refused", () => {
    const reply = {
      desired: null,
      window: { weekday: 2, startUtc: "09:00", hours: 4 },
      paused: false,
      commands: [],
    };
    expect(HeartbeatReply.safeParse(reply).success).toBe(true);
    expect(
      HeartbeatReply.safeParse({
        ...reply,
        window: { ...reply.window, hours: 3 },
      }).success,
    ).toBe(false);
    expect(
      HeartbeatReply.safeParse({
        ...reply,
        window: { ...reply.window, startUtc: "24:00" },
      }).success,
    ).toBe(false);
  });

  test("the signed bytes are RFC 8785 JSON without the signature", () => {
    expect(
      canonicalCommand({
        ...command({ args: { b: 1, a: [true, null, "é"] } }),
        signature: "AAAA",
      }),
    ).toBe(
      '{"args":{"a":[true,null,"é"],"b":1},"expiresAt":"2026-11-18T12:30:00Z","id":"cmd-1","issuedAt":"2026-11-18T11:59:00Z","kind":"restart"}',
    );
  });

  test("only signed, current commands of a known kind are accepted", async () => {
    const service = await keys();
    const stranger = await keys();
    const good = await signCommand(command(), service.privateKey);
    const tampered = { ...good, args: { workload: "computer" } };
    const forged = await signCommand(
      command({ id: "cmd-2" }),
      stranger.privateKey,
    );
    const expired = await signCommand(
      command({ id: "cmd-3", expiresAt: "2026-11-18T11:59:30Z" }),
      service.privateKey,
    );
    const future = await signCommand(
      command({ id: "cmd-4", issuedAt: "2026-11-18T12:30:00Z" }),
      service.privateKey,
    );
    const unknownKind = {
      ...(await signCommand(command({ id: "cmd-5" }), service.privateKey)),
      kind: "delete-everything",
    };
    const unsigned = { ...command({ id: "cmd-6" }) };
    const { accepted, ignored } = await readCommands(
      [good, tampered, forged, expired, future, unknownKind, unsigned],
      service.publicKey,
      now,
    );
    expect(accepted.map((entry) => entry.id)).toEqual(["cmd-1"]);
    expect(ignored).toEqual([
      { id: "cmd-1", reason: "signature does not verify" },
      { id: "cmd-2", reason: "signature does not verify" },
      { id: "cmd-3", reason: "expired" },
      { id: "cmd-4", reason: "issued in the future" },
      { id: "cmd-5", reason: "unknown command kind" },
      { id: "cmd-6", reason: "malformed command" },
    ]);
  });

  test("the agent's reading of a reply lets an unknown command through to be ignored, not fail the reply", () => {
    const reply = {
      desired: null,
      window: { weekday: 1, startUtc: "08:00", hours: 6 },
      paused: false,
      commands: [{ id: "x", kind: "new-kind" }],
    };
    expect(HeartbeatReply.safeParse(reply).success).toBe(false);
    expect(HeartbeatReplyWire.safeParse(reply).success).toBe(true);
    expect(
      HeartbeatReplyWire.safeParse({ ...reply, extra: true }).success,
    ).toBe(false);
  });

  test("a command result is strict", () => {
    const result = {
      commandId: "cmd-1",
      ok: false,
      reason: "policy: restore-backup needs a person",
      finishedAt: "2026-11-18T12:01:00Z",
    };
    expect(CommandResult.parse(result)).toEqual(result);
    expect(CommandResult.safeParse({ ...result, log: "..." }).success).toBe(
      false,
    );
  });

  test("the release manifest digest is the SHA-256 of its exact bytes", async () => {
    expect(await releaseManifestDigest("{}\n")).toBe(
      "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    );
  });
});
