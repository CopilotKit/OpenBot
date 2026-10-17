// server/tests/provider-undecided.test.ts
/**
 * "Which provider" has THREE ways of having no answer, and none of them is "Composio is active".
 *
 * `activeProvider` answers null when no key is set, when both keys are set and
 * `OPENBOT_BROKER_PROVIDER` names neither, and when the variable names a provider whose key is
 * unset. The entrypoint and the plugins routes both used to flatten all three with `?? "composio"`,
 * so a deployment part-way through a migration — both keys set, variable not yet set, which
 * `docs/plugins/arcade.md` calls legal — read its live Arcade rows through Composio's filter and
 * Composio's url parser. Those connections showed as absent and could not be revoked.
 *
 * What is asserted here: the three causes are told apart at the source; a deployment whose
 * configuration cannot name a provider takes the name from the rows it actually holds; rows
 * belonging to BOTH providers with nothing active is refused rather than resolved; and the plugins
 * routes read the one name the stores were built with instead of deciding a second time.
 */
import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { AccountModeSwitch } from "../src/plugins/account-mode";
import { providerDecision } from "../src/plugins/broker";
import { storedProvider } from "../src/plugins/provider-wiring";
import { createPluginRoutes } from "../src/plugins/routes";
import type { SharedUseStore } from "../src/plugins/shared-use-store";
import type { PluginStore } from "../src/plugins/store";

describe("the three causes of an undecided provider are told apart", () => {
  test("no key at all is its own cause", () => {
    expect(providerDecision({})).toEqual({ kind: "unconfigured" });
  });

  test("one key and no variable is that provider, active", () => {
    expect(providerDecision({ arcadeApiKey: "k" })).toEqual({
      kind: "active",
      provider: "arcade",
    });
  });

  test("both keys with nothing named is ambiguous, not Composio", () => {
    expect(
      providerDecision({ composioApiKey: "c", arcadeApiKey: "a" }),
    ).toEqual({ kind: "ambiguous", configured: ["composio", "arcade"] });
  });

  test("a named provider whose key is unset is its own cause", () => {
    expect(
      providerDecision({ composioApiKey: "c", brokerProvider: "arcade" }),
    ).toEqual({ kind: "misnamed", named: "arcade" });
  });
});

describe("a deployment that cannot name a provider takes the name from its rows", () => {
  test("both keys, nothing named, Arcade rows: the rows are read as Arcade", () => {
    const decision = providerDecision({
      composioApiKey: "c",
      arcadeApiKey: "a",
    });
    expect(storedProvider(decision, ["arcade"])).toBe("arcade");
  });

  test("a key withdrawn after the fact still reads its own rows", () => {
    expect(storedProvider(providerDecision({}), ["arcade"])).toBe("arcade");
  });

  test("an active provider is the answer whatever the rows say", () => {
    expect(
      storedProvider(providerDecision({ composioApiKey: "c" }), ["composio"]),
    ).toBe("composio");
  });

  test("rows at both vendors and nothing active is refused, never resolved", () => {
    const decision = providerDecision({
      composioApiKey: "c",
      arcadeApiKey: "a",
    });
    expect(() => storedProvider(decision, ["composio", "arcade"])).toThrow(
      /OPENBOT_BROKER_PROVIDER/,
    );
    // It names the way out that exists — by hand, at a vendor — and never an unbuilt flow.
    let message = "";
    try {
      storedProvider(decision, ["composio", "arcade"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      "delete its rows from brokered_connections by hand",
    );
    expect(message).not.toContain("sunset");
  });
});

/**
 * The routes read the name the stores were built with. The case is the migration state exactly: no
 * broker is wired (neither key is active), so the `composio` bag the routes take is absent, and the
 * store holds Arcade rows.
 */
describe("the plugins routes read one name, not a second answer", () => {
  function arcadeDeploymentWithNoBroker() {
    const switched: Array<{ serverId: string; mode: string }> = [];
    const store = {
      brokerProvider: "arcade" as const,
      serverAddress: async (serverId: string) =>
        serverId === "brokered-gmail"
          ? {
              id: "brokered-gmail",
              title: "Gmail",
              url: "arcade://Gmail",
              authScheme: "OAUTH2",
            }
          : undefined,
      listServers: async () => [],
      listSkills: async () => [],
    } as unknown as PluginStore;

    const modes = {
      switchMode: async (input: { serverId: string; mode: string }) => {
        switched.push({ serverId: input.serverId, mode: input.mode });
        return { ended: [], approved: [] };
      },
      forgetRule: async () => {},
    } as unknown as AccountModeSwitch;

    const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "admin-1",
        email: "admin@example.test",
        role: "admin",
      } as never);
      await next();
    };

    const app = new Hono().route(
      "/api/plugins",
      createPluginRoutes(
        store,
        signedIn,
        async () => true,
        undefined,
        undefined,
        { modes, use: {} as unknown as SharedUseStore },
      ),
    );
    return { app, switched };
  }

  test("an Arcade row is read with Arcade's parser though no broker is wired", async () => {
    const it = arcadeDeploymentWithNoBroker();
    const response = await it.app.request(
      "http://openbot.test/api/plugins/servers/brokered-gmail/account-mode",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "shared" }),
      },
    );
    expect(response.status).toBe(200);
    expect(it.switched).toEqual([
      { serverId: "brokered-gmail", mode: "shared" },
    ]);
  });

  test("and the page names Arcade rather than Composio", async () => {
    const it = arcadeDeploymentWithNoBroker();
    const response = await it.app.request("http://openbot.test/api/plugins");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { provider: string }).provider).toBe(
      "arcade",
    );
  });
});
