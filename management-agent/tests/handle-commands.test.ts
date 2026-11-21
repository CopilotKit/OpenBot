import { describe, expect, test } from "bun:test";
import {
  type CommandResult,
  signCommand,
  toBase64,
  type UnsignedCommand,
} from "../../shared/management-contract";
import { ManagementAgent } from "../src/agent";

async function setup() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = toBase64(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const maps = new Map<string, Record<string, string>>();
  const patches: unknown[] = [];
  const kube = {
    get: async (_namespace: string, resource: string, name: string) =>
      resource === "configmap" && maps.has(name)
        ? { data: maps.get(name) }
        : null,
    apply: async (manifest: {
      metadata: { name: string };
      data: Record<string, string>;
    }) => {
      maps.set(manifest.metadata.name, manifest.data);
      return "";
    },
    patch: async (...args: unknown[]) => {
      patches.push(args);
      return "";
    },
  };
  const results: CommandResult[] = [];
  const client = {
    result: async (result: CommandResult) => {
      results.push(result);
    },
  };
  const now = new Date("2026-11-19T12:00:00Z");
  const agent = new ManagementAgent(
    {
      config: {
        commandPublicKey: publicKey,
        agentNamespace: "openbot-system",
        stateConfigMap: "openbot-agent-state",
        product: { helmRelease: "openbot" },
      },
    } as never,
    kube as never,
    client as never,
    () => {},
    () => now,
  );
  const sign = (command: Partial<UnsignedCommand> & { id: string }) =>
    signCommand(
      {
        kind: "pause",
        args: {},
        issuedAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        ...command,
      },
      pair.privateKey,
    );
  return { agent, sign, patches, results };
}

describe("ManagementAgent.handleCommands", () => {
  test("a signed command id repeated in one reply runs once", async () => {
    const { agent, sign, patches } = await setup();
    const command = await sign({ id: "pause-1" });
    await agent.handleCommands([command, command]);
    expect(patches).toHaveLength(1);
  });

  test("a command rejected before it could run is not recorded as handled", async () => {
    const { agent, sign, patches } = await setup();
    const future = new Date("2026-11-19T12:30:00Z").toISOString();
    const early = await sign({ id: "pause-2", issuedAt: future });
    await agent.handleCommands([early]);
    expect(patches).toHaveLength(0);
    // The same id, correctly issued, still runs.
    await agent.handleCommands([await sign({ id: "pause-2" })]);
    expect(patches).toHaveLength(1);
  });

  test("a malformed command cannot pre-mark an id a later signed command uses", async () => {
    const { agent, sign, patches } = await setup();
    await agent.handleCommands([{ id: "pause-3", kind: "pause" }]);
    await agent.handleCommands([await sign({ id: "pause-3" })]);
    expect(patches).toHaveLength(1);
  });

  test("an expired command is recorded and answered once", async () => {
    const { agent, sign, patches, results } = await setup();
    const old = new Date("2026-11-19T11:00:00Z").toISOString();
    const expired = await sign({ id: "pause-4", expiresAt: old });
    await agent.handleCommands([expired]);
    await agent.handleCommands([expired]);
    expect(patches).toHaveLength(0);
    expect(results.map((result) => result.reason)).toEqual([
      "ignored: expired",
    ]);
  });
});
