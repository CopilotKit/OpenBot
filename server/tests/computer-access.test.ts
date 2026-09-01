import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { computerAccessOf } from "../src/computer/access";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { loadConfig } from "../src/config";
import {
  loadTenantPackage,
  validateTenantPackage,
} from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "operator",
    email: "operator@netsfera.test",
    role: "admin",
  });
  await next();
};

describe("per-agent computer access", () => {
  test("loads both Netsfera G0 Bots as explicitly disabled", async () => {
    const tenant = await loadTenantPackage("examples/netsfera");

    expect(
      tenant.agents.find((agent) => agent.id === "jefe-erp")?.configuration,
    ).toMatchObject({ computerAccess: "disabled" });
    expect(
      tenant.agents.find((agent) => agent.id === "recolector-documentos")
        ?.configuration,
    ).toMatchObject({ computerAccess: "disabled" });
  });

  test("preserves computer access for a legacy package that omitted the setting", () => {
    const tenant = validateTenantPackage({
      brand: "tenant: { id: legacy, product_name: Legacy }",
      agents:
        "agents: [{ id: legacy-bot, name: Legacy, title: Legacy, role_description: Helps., type: built-in, system_prompt: Helps. }]",
      channels: "channels: []",
      model:
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
      knowledge: "sources: []",
      themeCss: "",
    });

    expect(computerAccessOf(tenant.agents[0]?.configuration)).toBe("enabled");
  });

  test("recognises a disabled and an enabled stored agent configuration", () => {
    expect(computerAccessOf({ computerAccess: "disabled" })).toBe("disabled");
    expect(computerAccessOf({ computerAccess: "enabled" })).toBe("enabled");
    expect(computerAccessOf({ computerAccess: "unexpected" })).toBe("disabled");
  });
});

describe("computer routes enforce per-agent access before every gateway call", () => {
  test("createApp without a profile store refuses a Bot and never reaches its computer", async () => {
    const reached: string[] = [];
    const app = createApp(
      loadConfig(
        testEnvironment({
          OPENBOT_SINGLE_USER: "true",
          GOOGLE_OAUTH_CLIENT_ID: undefined,
          GOOGLE_OAUTH_CLIENT_SECRET: undefined,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_URL: undefined,
        }),
      ),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        read: async (botId: string) => {
          reached.push(botId);
          return { text: "private page" };
        },
      } as unknown as ComputerGateway,
      {} as PolicyStore,
    );

    const response = await app.request(
      "http://openbot.test/api/computers/no-store/read",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "There is no such Bot.",
    });
    expect(reached).toEqual([]);
  });

  test.each([
    ["jefe-erp", "/read", "GET"],
    ["recolector-documentos", "/snapshot", "POST"],
    ["jefe-erp", "/screenshot", "GET"],
  ])(
    "refuses %s%s even when it bypasses the frontend tool offer",
    async (botId, path, method) => {
      const reached: string[] = [];
      const gateway = {
        read: async () => {
          reached.push("read");
          return { text: "private page" };
        },
        snapshot: async () => {
          reached.push("snapshot");
          return { snapshotId: 1, elements: [] };
        },
        screenshot: async () => {
          reached.push("screenshot");
          return { image: "" };
        },
      } as unknown as ComputerGateway;
      const routes = createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asSignedIn,
        async () => true,
        undefined,
        undefined,
        async () => false,
      );

      const response = await routes.request(
        `http://openbot.test/${botId}${path}`,
        {
          method,
        },
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "This Bot does not have computer access.",
      });
      expect(reached).toEqual([]);
    },
  );

  test("still forwards a direct read for an enabled Bot", async () => {
    const reached: string[] = [];
    const routes = createComputerRoutes(
      {
        read: async (botId: string) => {
          reached.push(botId);
          return { text: "visible page" };
        },
      } as unknown as ComputerGateway,
      {} as PolicyStore,
      asSignedIn,
      async () => true,
      undefined,
      undefined,
      async () => true,
    );

    const response = await routes.request(
      "http://openbot.test/legacy-bot/read",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "visible page" });
    expect(reached).toEqual(["legacy-bot"]);
  });

  test("refuses a route that was wired without the entitlement callback", async () => {
    const reached: string[] = [];
    const routes = createComputerRoutes(
      {
        read: async () => {
          reached.push("read");
          return { text: "private page" };
        },
      } as unknown as ComputerGateway,
      {} as PolicyStore,
      asSignedIn,
      async () => true,
    );

    const response = await routes.request("http://openbot.test/any-bot/read");

    expect(response.status).toBe(403);
    expect(reached).toEqual([]);
  });
});
