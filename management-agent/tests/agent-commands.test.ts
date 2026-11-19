/**
 * Command handling in one heartbeat: the idempotency the agent promises is enforced against the
 * state ConfigMap it read at the start of handleCommands(), which does not change while commands in
 * the same reply are being handled. Two copies of one id must not both run, and an id that has not
 * been signed (or is only ahead of this clock) must not be remembered as handled.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  signCommand,
  toBase64,
  type UnsignedCommand,
} from "../../shared/management-contract";
import { ManagementAgent } from "../src/agent";
import type { ManagementClient } from "../src/client";
import type { Agent, AgentConfig } from "../src/config";
import type { Kube } from "../src/kube";

const installId = "6f1c1a52-2f0e-4c3b-9b1e-6a3f0f6b2d11";
const NAMESPACE = "openbot-system";
const CONFIG_MAP = "openbot-agent-state";
const START = Date.parse("2026-01-01T00:00:00.000Z");

function makeConfig(publicKey: string): AgentConfig {
  return {
    managementUrl: "https://management.example.test",
    installId,
    cloud: "other",
    commandPublicKey: publicKey,
    window: null,
    agentNamespace: NAMESPACE,
    product: {
      chart: "bundle",
      releaseName: "openbot",
      namespace: "openbot",
      helmRelease: "openbot",
      ociRepository: "openbot",
      pinsConfigMap: "openbot-pins",
    },
    backup: { kind: "command", timeoutSeconds: 600 },
    stateConfigMap: CONFIG_MAP,
    supportBundle: { pvc: "support-bundle" },
  };
}

/** The calls the agent makes to kubectl: one rollout restart per command that actually runs. */
class FakeKube {
  data: Record<string, string> = {};
  readonly calls: string[][] = [];

  async get<T>(_namespace: string, _resource: string, _name: string) {
    return { data: { ...this.data } } as T;
  }
  async apply(value: { data?: Record<string, string> }) {
    this.data = { ...value.data };
    this.calls.push(["apply"]);
  }
  async list<T>(_namespace: string, resource: string, _selector?: string) {
    return (
      resource === "deployment" ? [{ metadata: { name: "api" } }] : []
    ) as T;
  }
  async kubectl(args: string[]) {
    this.calls.push([...args]);
    return "";
  }
}

class FakeClient {
  readonly results: { commandId: string; ok: boolean; reason: string }[] = [];

  async result(value: { commandId: string; ok: boolean; reason: string }) {
    this.results.push(value);
  }
  async heartbeat(): Promise<never> {
    throw new Error("not used by these tests");
  }
}

let privateKey: CryptoKey;
let now: number;
let kube: FakeKube;
let client: FakeClient;
let agent: ManagementAgent;

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const publicKey = toBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  now = START;
  kube = new FakeKube();
  client = new FakeClient();
  const agentConfig: Agent = {
    config: makeConfig(publicKey),
    credentials: { cert: "", key: "" },
    jobs: { backup: "", supportBundle: "" },
  };
  agent = new ManagementAgent(
    agentConfig,
    kube as unknown as Kube,
    client as unknown as ManagementClient,
    () => {},
    () => new Date(now),
  );
});

function unsigned(id: string, overrides: Partial<UnsignedCommand> = {}) {
  return {
    id,
    kind: "restart" as const,
    args: {},
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

function handled(): string[] {
  const raw = kube.data["state.json"];
  return raw
    ? (JSON.parse(raw) as { handledCommands: string[] }).handledCommands
    : [];
}

function restarts() {
  return kube.calls.filter(
    (call) => call.includes("rollout") && call.includes("restart"),
  );
}

describe("command idempotency in one heartbeat", () => {
  test("a signed command repeated in one reply runs only once", async () => {
    const signed = await signCommand(unsigned("c1"), privateKey);
    await agent.handleCommands([signed, signed]);

    expect(restarts()).toHaveLength(1);
    expect(handled()).toEqual(["c1"]);
  });

  test("an unverified id cannot suppress a real signed command with the same id", async () => {
    const unknownKind = {
      ...unsigned("c1"),
      kind: "not-a-command",
    };
    const signed = await signCommand(unsigned("c1"), privateKey);

    await agent.handleCommands([unknownKind, signed]);

    // Before the fix the malformed entry marked c1 handled, so the real command was skipped.
    expect(restarts()).toHaveLength(1);
    expect(handled()).toEqual(["c1"]);
  });

  test("a future-dated command stays runnable once the clocks agree", async () => {
    const future = await signCommand(
      unsigned("c2", { issuedAt: new Date(now + 10 * 60_000).toISOString() }),
      privateKey,
    );
    await agent.handleCommands([future]);
    expect(restarts()).toHaveLength(0);
    expect(handled()).toEqual([]);

    now += 11 * 60_000;
    await agent.handleCommands([future]);
    expect(restarts()).toHaveLength(1);
    expect(handled()).toEqual(["c2"]);
  });

  test("an expired command is still recorded as handled", async () => {
    const expired = await signCommand(
      unsigned("c3", { expiresAt: new Date(now - 1000).toISOString() }),
      privateKey,
    );
    await agent.handleCommands([expired]);

    expect(restarts()).toHaveLength(0);
    expect(handled()).toEqual(["c3"]);
    expect(client.results.map((result) => result.commandId)).toEqual(["c3"]);
  });
});
