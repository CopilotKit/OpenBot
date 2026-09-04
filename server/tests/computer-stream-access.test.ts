import { describe, expect, test } from "bun:test";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { computerAccessOf } from "../src/computer/access";
import { locateComputerStream } from "../src/computer/stream-access";

const actor: AgentActor = { id: "operator", role: "admin" };

function profile(computerAccess: unknown): AgentProfile {
  return {
    id: "bot",
    name: "Bot",
    title: "Bot",
    roleDescription: "Test Bot.",
    avatarSeed: "bot",
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    computerAccess: computerAccess as AgentProfile["computerAccess"],
    hasCallbackToken: false,
  };
}

function profileStore(
  read: () => Promise<AgentProfile | null>,
): Pick<AgentProfileStore, "get"> {
  return { get: async () => read() };
}

function gatewayCalls() {
  const calls: string[] = [];
  return {
    calls,
    gateway: {
      locate: async (botId: string) => {
        calls.push(botId);
        return "http://computer.internal:4100";
      },
    },
  };
}

describe("computer WebSocket stream access", () => {
  test.each(["jefe-erp", "recolector-documentos"])(
    "refuses explicitly disabled %s before locating its computer",
    async (botId) => {
      const { gateway, calls } = gatewayCalls();

      await expect(
        locateComputerStream({
          profileStore: profileStore(async () => profile("disabled")),
          actor,
          botId,
          gateway,
        }),
      ).resolves.toEqual({ kind: "denied" });
      expect(calls).toEqual([]);
    },
  );

  test("refuses malformed access before locating its computer", async () => {
    const { gateway, calls } = gatewayCalls();

    await expect(
      locateComputerStream({
        profileStore: profileStore(async () => profile("unexpected")),
        actor,
        botId: "malformed",
        gateway,
      }),
    ).resolves.toEqual({ kind: "denied" });
    expect(calls).toEqual([]);
  });

  test.each([
    ["no profile store", undefined],
    ["no profile", profileStore(async () => null)],
  ] as const)(
    "refuses %s before locating its computer",
    async (_case, store) => {
      const { gateway, calls } = gatewayCalls();

      await expect(
        locateComputerStream({
          profileStore: store,
          actor,
          botId: "absent",
          gateway,
        }),
      ).resolves.toEqual({ kind: "denied" });
      expect(calls).toEqual([]);
    },
  );

  test("refuses a profile lookup error before locating its computer", async () => {
    const { gateway, calls } = gatewayCalls();

    await expect(
      locateComputerStream({
        profileStore: profileStore(async () => {
          throw new Error("database connection reset");
        }),
        actor,
        botId: "lookup-error",
        gateway,
      }),
    ).resolves.toEqual({ kind: "denied" });
    expect(calls).toEqual([]);
  });

  test("locates an explicitly enabled Bot only after entitlement succeeds", async () => {
    const { gateway, calls } = gatewayCalls();

    await expect(
      locateComputerStream({
        profileStore: profileStore(async () => profile("enabled")),
        actor,
        botId: "enabled",
        gateway,
      }),
    ).resolves.toEqual({
      kind: "permitted",
      baseUrl: "http://computer.internal:4100",
    });
    expect(calls).toEqual(["enabled"]);
  });

  test("locates a genuinely legacy omitted configuration after its canonical normalization", async () => {
    const { gateway, calls } = gatewayCalls();
    const legacyStoredConfiguration = {
      endpoint: "https://legacy.example/ag-ui",
    };

    await expect(
      locateComputerStream({
        // profile-store maps the actual persisted omission through computerAccessOf before exposing
        // a profile. The stream receives that normalized entitlement, never a separate default.
        profileStore: profileStore(async () =>
          profile(computerAccessOf(legacyStoredConfiguration)),
        ),
        actor,
        botId: "legacy",
        gateway,
      }),
    ).resolves.toEqual({
      kind: "permitted",
      baseUrl: "http://computer.internal:4100",
    });
    expect(calls).toEqual(["legacy"]);
  });
});
