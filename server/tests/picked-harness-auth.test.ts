import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { RunAgentInput } from "@ag-ui/client";
import { BunSQLPreparedQuery } from "drizzle-orm/bun-sql";
import type { PreparedQueryConfig } from "drizzle-orm/pg-core";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { buildAgents } from "../src/copilot";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

const fixtureToken = "synthetic-deployment-token";
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Real query construction, with only the SQL execution boundary replaced. No database connects. */
async function runPicked(options: {
  bundled: boolean;
  installed: boolean;
  target?: "picked" | "bundled" | "customer";
  customerAuth?: boolean;
  spelling?: "uppercase";
  configuredQuery?: string;
  rowEndpoint?: (endpoint: string) => string;
  expectedManaged?: boolean;
  invalidCompanion?: boolean;
  packageProducer?: boolean;
}) {
  const requests: {
    path: string;
    search: string;
    method: string;
    headerNames: string[];
    status: number;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const managed =
        options.expectedManaged ??
        (path.replace(/\/+$/, "") === "/bundled/ag-ui" ||
          (path.replace(/\/+$/, "") === "/picked/ag-ui" && options.installed));
      const authorized = managed
        ? request.headers.get("x-openbot-agent-token") === fixtureToken
        : options.customerAuth
          ? request.headers.get("Authorization") ===
              "Bearer synthetic-customer-key" &&
            !request.headers.has("x-openbot-agent-token")
          : !request.headers.has("x-openbot-agent-token");
      const status = authorized ? 200 : 401;
      requests.push({
        path,
        search: new URL(request.url).search,
        method: request.method,
        headerNames: [...request.headers.keys()].sort(),
        status,
      });
      if (!authorized)
        return Response.json({ error: "unauthorised" }, { status });
      const input: RunAgentInput = await request.json();
      return new Response(
        [
          { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
          {
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    },
  });
  const endpoint = (name: string) => {
    const value = new URL(
      `/${name}/ag-ui${options.configuredQuery ?? ""}`,
      server.url,
    ).toString();
    return options.spelling === "uppercase"
      ? value.replace("http://127.0.0.1", "HTTP://LOCALHOST")
      : value;
  };
  let storedEndpoint = endpoint(options.target ?? "picked");
  if (options.packageProducer) {
    const publicEnvironment = {
      MANAGED_AGENT_AG_UI_URL: options.bundled ? endpoint("bundled") : "",
      PICKED_HARNESS_URL: endpoint("picked"),
      PICKED_HARNESS_KIND: "remote-ag-ui",
    };
    const previous = new Map(
      Object.keys(publicEnvironment).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, publicEnvironment);
      const tenant = await loadTenantPackage(
        fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
      );
      const picked = tenant.agents.find(
        (agent) => agent.id === "picked-harness",
      );
      if (!picked || typeof picked.configuration.endpoint !== "string")
        throw new Error("Expected endpoint from default package producer");
      expect(picked.configuration.endpoint).toBe(endpoint("picked"));
      storedEndpoint = picked.configuration.endpoint;
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  storedEndpoint = options.rowEndpoint?.(storedEndpoint) ?? storedEndpoint;
  const config = loadConfig(
    testEnvironment({
      KEY_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/never-connect",
      MANAGED_AGENT_AG_UI_URL: options.bundled ? endpoint("bundled") : "",
      MANAGED_AGENT_TOKEN: fixtureToken,
      PICKED_HARNESS_URL: endpoint("picked"),
      PICKED_HARNESS_IMAGE: options.installed
        ? "localhost/synthetic-harness:fixture"
        : "",
    }),
  );
  const database = createDatabase(config.databaseUrl);
  let sqlCalls = 0;
  const refuseDatabase = spyOn(database.$client, "unsafe").mockImplementation(
    () => {
      throw new Error("This fixture must never connect to a database");
    },
  );
  const execute = spyOn(
    BunSQLPreparedQuery.prototype,
    "execute",
  ).mockImplementation(async function (
    this: BunSQLPreparedQuery<PreparedQueryConfig>,
  ) {
    const { sql } = this.getQuery();
    sqlCalls++;
    if (
      sql.startsWith("select distinct ") &&
      sql.includes('"agent_profiles"."deleted_at" is not null')
    )
      return [];
    if (
      !sql.startsWith("select ") ||
      !sql.includes('"agent_profiles"."deleted_at" is null')
    ) {
      throw new Error("Unexpected SQL at the controlled roster boundary");
    }
    const rows = [
      {
        id: "picked-harness",
        name: "Picked Harness",
        type: "remote_ag_ui",
        title: "Synthetic harness",
        roleDescription: "Answer the controlled protocol request.",
        configuration: {
          endpoint: storedEndpoint,
          ...(options.customerAuth
            ? {
                auth: {
                  header: "Authorization",
                  credentialId: "synthetic-customer",
                },
              }
            : {}),
        },
      },
    ];
    return options.invalidCompanion
      ? [
          ...rows,
          {
            ...rows[0],
            id: "invalid-companion",
            configuration: { endpoint: "not a valid URL" },
          },
        ]
      : rows;
  });
  let credentialReads = 0;
  let failed = false;
  try {
    const app = createApp(
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: {
              id: "fixture-actor",
              email: "fixture@example.test",
              name: "Fixture",
            },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createAgentProfileStore(database, config.managedAgent?.endpoint),
    );
    const capabilities = await app.request(
      "http://fixture.test/api/agents/capabilities",
    );
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      capabilities: { builtInAvailable: options.bundled },
    });
    const vault = options.customerAuth
      ? {
          encryptionKey,
          reader: {
            async readSecret(id: string) {
              expect(id).toBe("synthetic-customer");
              credentialReads++;
              return {
                encryptedValue: await encryptSecret(
                  encryptionKey,
                  "Bearer synthetic-customer-key",
                ),
                revokedAt: null,
              };
            },
          },
        }
      : undefined;
    const loaded = await createRuntimeAgentLoader(
      database,
      vault,
      config.managedAgent,
    )({ id: "fixture-actor", role: "admin" });
    expect(loaded).toHaveLength(1);
    const agents = await buildAgents(
      loaded,
      { provider: "openai", defaultModel: "unused" },
      null,
    );
    const agent = agents["picked-harness"];
    if (!agent)
      throw new Error("Expected picked harness from production loader");
    agent.threadId = "synthetic-auth-thread";
    const quietFailure = spyOn(console, "error").mockImplementation(() => {});
    try {
      await agent.runAgent({ runId: "synthetic-auth-run" });
    } catch {
      failed = true;
    } finally {
      quietFailure.mockRestore();
    }
    expect(sqlCalls).toBe(2);
    expect(refuseDatabase).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    console.log(
      JSON.stringify({
        boundary: "config-loader-buildAgents-HTTP",
        ...options,
        requests,
        failed,
      }),
    );
    return { config, requests, failed, credentialReads };
  } finally {
    execute.mockRestore();
    refuseDatabase.mockRestore();
    await database.$client.close();
    await server.stop(true);
  }
}

test("a plan's installed picked harness authenticates without advertising a bundled Bot", async () => {
  const result = await runPicked({ bundled: false, installed: true });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
  expect(result.config.managedAgent?.endpoint).toBeUndefined();
});

test.each(["picked", "bundled"] as const)(
  "an eligible deployment authenticates its %s endpoint",
  async (target) => {
    const result = await runPicked({ bundled: true, installed: true, target });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.failed).toBe(false);
    expect(result.config.managedAgent?.endpoint).toBeDefined();
  },
);

test.each([false, true])(
  "BYO keeps customer auth without a deployment token (bundled=%p)",
  async (bundled) => {
    const result = await runPicked({
      bundled,
      installed: false,
      customerAuth: true,
    });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.requests[0]?.headerNames).not.toContain(
      "x-openbot-agent-token",
    );
    expect(result.requests[0]?.headerNames).toContain("authorization");
    expect(result.credentialReads).toBe(1);
    expect(result.failed).toBe(false);
  },
);

test("an unrelated customer endpoint receives no deployment token", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    target: "customer",
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.requests[0]?.headerNames).not.toContain(
    "x-openbot-agent-token",
  );
});

test("a picked installed harness requires a token even when the bundled Bot is omitted", () => {
  expect(() =>
    loadConfig(
      testEnvironment({
        MANAGED_AGENT_AG_UI_URL: "",
        MANAGED_AGENT_TOKEN: "",
        PICKED_HARNESS_IMAGE: "localhost/synthetic-harness:fixture",
        PICKED_HARNESS_URL: "http://127.0.0.1:4206/ag-ui",
      }),
    ),
  ).toThrow("MANAGED_AGENT_TOKEN");
});

test("the default package's case-only picked URL authenticates through the real HTTP client", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    spelling: "uppercase",
    packageProducer: true,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
  expect(result.config.managedAgent?.endpoint).toBeUndefined();
});

test.each(["picked", "bundled"] as const)(
  "canonical matching authenticates uppercase %s endpoints",
  async (target) => {
    const result = await runPicked({
      bundled: true,
      installed: true,
      target,
      spelling: "uppercase",
    });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.failed).toBe(false);
  },
);

test("canonical matching keeps trailing pathname slash tolerance", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    spelling: "uppercase",
    rowEndpoint: (endpoint) => `${endpoint}/`,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
});

test.each([
  [
    "path case",
    "",
    (endpoint: string) => endpoint.replace("/picked/", "/Picked/"),
  ],
  [
    "query value",
    "?owner=managed",
    (endpoint: string) => endpoint.replace("owner=managed", "owner=customer"),
  ],
  [
    "query trailing slash",
    "?owner=customer",
    (endpoint: string) => `${endpoint}/`,
  ],
] as const)(
  "a customer endpoint differing by %s keeps only its own credential",
  async (_difference, configuredQuery, rowEndpoint) => {
    const result = await runPicked({
      bundled: false,
      installed: true,
      configuredQuery,
      rowEndpoint,
      customerAuth: true,
      expectedManaged: false,
    });
    expect(result.requests.map((request) => request.status)).toEqual([200]);
    expect(result.requests[0]?.headerNames).not.toContain(
      "x-openbot-agent-token",
    );
    expect(result.requests[0]?.headerNames).toContain("authorization");
    expect(result.credentialReads).toBe(1);
    expect(result.failed).toBe(false);
  },
);

test("uppercase BYO endpoints keep customer auth without a deployment token", async () => {
  const result = await runPicked({
    bundled: true,
    installed: false,
    spelling: "uppercase",
    customerAuth: true,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.requests[0]?.headerNames).not.toContain(
    "x-openbot-agent-token",
  );
  expect(result.failed).toBe(false);
});

test("an invalid stored companion does not prevent the valid managed agent from loading", async () => {
  const result = await runPicked({
    bundled: false,
    installed: true,
    invalidCompanion: true,
  });
  expect(result.requests.map((request) => request.status)).toEqual([200]);
  expect(result.failed).toBe(false);
});
