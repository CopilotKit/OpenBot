import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEnrollmentToken,
  CertificateIssued,
  CertificateRequest,
  CommandResult,
  canonicalCommand,
  EnrollmentGranted,
  EnrollmentPending,
  EnrollmentProblem,
  EnrollmentStart,
  EnrollmentStarted,
  enrollmentTokenPath,
  Heartbeat,
  HeartbeatReply,
  HeartbeatReplyWire,
  InstallStatus,
  installCertificateSubject,
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

/** A real key, request and self-signed certificate from openssl, as an agent and a CA make them. */
function opensslPems() {
  const directory = mkdtempSync(join(tmpdir(), "enroll-contract-"));
  const run = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  try {
    run(
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "agent.key",
      "-subj",
      "/O=CopilotKit/OU=install/CN=6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11",
      "-out",
      "agent.csr",
    );
    run(
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "ca.key",
      "-subj",
      "/CN=test CA",
      "-days",
      "1",
      "-out",
      "ca.crt",
    );
    const read = (file: string) => readFileSync(join(directory, file), "utf8");
    return {
      csr: read("agent.csr"),
      cert: read("ca.crt"),
      key: read("agent.key"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("enrollment contract", () => {
  const installId = "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11";
  const token = "e1_Q2hhbmdlIG1lIGlzIG5vdCBhIHRva2VuIGJ1dCBpdCBpcyBsb25n";
  const pems = opensslPems();

  test("an enrollment start and its answer parse, and nothing else rides along", () => {
    const start = {
      licenseToken: "eyJhbGciOiJFZERTQSJ9.e30.sig",
      installName: "Production (us-east-2)",
      serverUrl: "https://openbot.example.com",
    };
    expect(EnrollmentStart.parse(start)).toEqual(start);
    expect(
      EnrollmentStart.safeParse({ ...start, orgId: "org_123" }).success,
    ).toBe(false);
    expect(
      EnrollmentStart.safeParse({ ...start, serverUrl: "file:///etc/passwd" })
        .success,
    ).toBe(false);
    const started = {
      requestId: "0b7f4f2e-3a49-4f61-9d2c-6c1d5a7e8f90",
      userCode: "BDFH-KLMN",
      verificationUri: "https://enroll.bot.copilotkit.ai/connect",
      verificationUriComplete:
        "https://enroll.bot.copilotkit.ai/connect?code=BDFH-KLMN",
      interval: 5,
      expiresIn: 900,
    };
    expect(EnrollmentStarted.parse(started)).toEqual(started);
    expect(
      EnrollmentStarted.safeParse({ ...started, userCode: "bdfhklmn" }).success,
    ).toBe(false);
  });

  test("the token poll answers either an RFC 8628 error or the token, once", () => {
    for (const error of [
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
    ])
      expect(EnrollmentPending.safeParse({ error }).success).toBe(true);
    expect(
      EnrollmentPending.safeParse({ error: "invalid_grant" }).success,
    ).toBe(false);
    const granted = {
      installId,
      enrollmentToken: token,
      statusToken: `s1_${token}`,
      expiresIn: 3600,
    };
    expect(EnrollmentGranted.parse(granted)).toEqual(granted);
    expect(
      EnrollmentGranted.safeParse({ ...granted, enrollmentToken: "short" })
        .success,
    ).toBe(false);
    expect(
      EnrollmentGranted.safeParse({
        ...granted,
        enrollmentToken: `${token} ; rm -rf /`,
      }).success,
    ).toBe(false);
    expect(enrollmentTokenPath("a/b")).toBe("/enroll/v1/requests/a%2Fb/token");
  });

  test("a certificate request carries a real PKCS#10 request and never a private key", () => {
    expect(
      CertificateRequest.parse({ enrollmentToken: token, csrPem: pems.csr }),
    ).toEqual({ enrollmentToken: token, csrPem: pems.csr });
    expect(
      CertificateRequest.safeParse({ enrollmentToken: token, csrPem: pems.key })
        .success,
    ).toBe(false);
    expect(
      CertificateRequest.safeParse({
        enrollmentToken: token,
        csrPem: pems.csr,
        privateKeyPem: pems.key,
      }).success,
    ).toBe(false);
  });

  test("an issued certificate is one certificate and a chain of one or more", () => {
    const issued = {
      installId,
      certificatePem: pems.cert,
      caChainPem: `${pems.cert}${pems.cert}`,
    };
    expect(CertificateIssued.parse(issued)).toEqual(issued);
    expect(
      CertificateIssued.safeParse({ ...issued, certificatePem: pems.csr })
        .success,
    ).toBe(false);
    expect(
      CertificateIssued.safeParse({ ...issued, privateKeyPem: pems.key })
        .success,
    ).toBe(false);
  });

  test("the install's subject is the one the service's identity check reads", () => {
    expect(installCertificateSubject(installId)).toBe(
      `CN=${installId}, OU=install, O=CopilotKit`,
    );
  });

  test("status, the agent's pickup and problems parse", () => {
    expect(
      InstallStatus.parse({
        enrolled: true,
        agentConnected: false,
        lastHeartbeatAt: null,
        agentVersion: null,
      }).enrolled,
    ).toBe(true);
    expect(
      AgentEnrollmentToken.safeParse({ installId, enrollmentToken: token })
        .success,
    ).toBe(true);
    expect(
      AgentEnrollmentToken.safeParse({
        installId,
        enrollmentToken: token,
        statusToken: token,
      }).success,
    ).toBe(false);
    expect(
      EnrollmentProblem.safeParse({
        type: "about:blank",
        title: "Licence not valid",
        status: 401,
        requestId: "x",
      }).success,
    ).toBe(true);
  });
});
