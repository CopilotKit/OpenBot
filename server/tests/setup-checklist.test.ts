import { describe, expect, jest, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { CredentialStatus } from "../src/credentials";
import type { ModelCheckOutcome } from "../src/model-availability-check";
import type { RuntimeEntitlementResponse } from "../src/self-host-banner";
import {
  createSetupSources,
  intelligenceFact,
  modelKeyOf,
  modelVerdict,
  RECHECK_INTERVAL_MS,
  type SetupChecklist,
  type SetupFacts,
  type SetupRow,
  setupRows,
} from "../src/setup/checklist";
import { createComputerCheck } from "../src/setup/computer-check";
import { testEnvironment } from "./support/environment";

/**
 * The setup checklist onboarding's "Check your setup" step draws: one row for each thing the
 * deployment depends on.
 *
 * What is pinned here is what the screen promises. The rows follow the server's own configuration,
 * an admin is told how to close each gap, a member is told only that it works or that their admin
 * sets it up, and no response ever carries a secret, whoever asks.
 */

const PRODUCT = "OpenBot";

const READY: SetupFacts = {
  intelligence: { state: "ready" },
  model: {
    provider: "openai",
    source: "environment",
    verdict: "available",
    model: "gpt-5.6-terra",
  },
  computer: true,
  computerStatus: "ready",
  apps: { configured: true, provider: "composio" },
  chat: true,
};

const UNSET: SetupFacts = {
  intelligence: { state: "ready" },
  model: {
    provider: "openai",
    source: null,
    verdict: "not_checked",
    model: "gpt-5.6-terra",
  },
  computer: false,
  apps: { configured: false, provider: "composio" },
  chat: false,
};

/** An entitlement answer Intelligence gives a self-hosted deployment with no licence. */
const UNLICENSED: RuntimeEntitlementResponse = {
  status: "misconfigured",
  error: {
    code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    message: "No licence.",
    retryable: false,
  },
};
const ENTITLED: RuntimeEntitlementResponse = {
  status: "ready",
  entitlement: {
    active: true,
    source: "selfHostedDeploymentLicense",
    features: {},
    limits: {},
  },
};

const row = (rows: SetupRow[], id: SetupRow["id"]) => {
  const found = rows.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} row`);
  return found;
};

describe("setup rows", () => {
  test("everything set reads Ready, with nothing to fix", () => {
    const rows = setupRows(READY, { productName: PRODUCT, audience: "admin" });

    expect(rows.map((candidate) => candidate.id)).toEqual([
      "intelligence",
      "model",
      "computer",
      "apps",
      "chat",
    ]);
    for (const candidate of rows) {
      expect(candidate.status).toBe("ready");
      expect(candidate.ready).toBe(true);
      expect(candidate.fix).toBeNull();
    }
  });

  test("only Intelligence and the model are required", () => {
    const rows = setupRows(READY, { productName: PRODUCT, audience: "admin" });
    expect(
      rows.filter((candidate) => candidate.required).map((c) => c.id),
    ).toEqual(["intelligence", "model"]);
  });

  test("an admin is told what each gap costs and how to close it", () => {
    const rows = setupRows(UNSET, { productName: PRODUCT, audience: "admin" });

    const model = row(rows, "model");
    expect(model.ready).toBe(false);
    expect(model.detail).toBe("Without a model key, OpenBot can't answer.");
    expect(model.fix).toEqual({
      kind: "env",
      names: ["OPENAI_API_KEY"],
      docsUrl: "https://github.com/CopilotKit/openbot#quick-start",
      page: { label: "Credentials", path: "/admin/credentials" },
    });

    expect(row(rows, "computer").fix).toMatchObject({
      kind: "env",
      names: ["AGENT_COMPUTER_URL", "COMPUTER_TOKEN"],
    });
    expect(row(rows, "apps").fix).toMatchObject({
      kind: "env",
      names: ["COMPOSIO_API_KEY"],
    });
    expect(row(rows, "apps").detail).toBe(
      "Without it, people can connect only the apps an admin adds.",
    );
    expect(row(rows, "chat").fix).toMatchObject({
      kind: "env",
      names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
    });
  });

  test("an Anthropic deployment names Anthropic's key", () => {
    const rows = setupRows(
      { ...UNSET, model: { ...UNSET.model, provider: "anthropic" } },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(rows, "model").fix).toMatchObject({
      names: ["ANTHROPIC_API_KEY"],
    });
  });

  test("a member sees their admin sets it up, and no variable name", () => {
    const rows = setupRows(UNSET, {
      productName: PRODUCT,
      audience: "member",
    });

    for (const candidate of rows.filter((c) => c.scope === "deployment")) {
      if (candidate.ready) continue;
      expect(candidate.detail).toBe("Your admin sets this up.");
      expect(candidate.fix).toBeNull();
    }
    const body = JSON.stringify(rows);
    for (const name of [
      "OPENAI_API_KEY",
      "COMPOSIO_API_KEY",
      "OPENTAG_SHARED_SECRET",
      "AGENT_COMPUTER_URL",
      "/admin/",
    ]) {
      expect(body).not.toContain(name);
    }
  });

  test("a key the provider refused is a gap, named for what was refused", () => {
    const key = setupRows(
      { ...READY, model: { ...READY.model, verdict: "refused_key" } },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(key, "model").status).toBe("needs_setup");
    expect(row(key, "model").detail).toBe(
      "OpenAI refused the model key, so OpenBot can't answer.",
    );

    const model = setupRows(
      { ...READY, model: { ...READY.model, verdict: "refused_model" } },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(model, "model").detail).toBe(
      "The model key can't use gpt-5.6-terra, so OpenBot can't answer.",
    );
  });

  test("a key nobody asked the provider about is not checked, never Ready", () => {
    const unchecked = setupRows(
      { ...READY, model: { ...READY.model, verdict: "not_checked" } },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(unchecked, "model")).toMatchObject({
      status: "not_checked",
      ready: false,
      detail: "Key set, not checked yet. Check again to ask OpenAI.",
      fix: null,
    });

    const custom = setupRows(
      { ...READY, model: { ...READY.model, verdict: "cannot_check" } },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(custom, "model")).toMatchObject({
      status: "not_checked",
      detail: "Key set. It uses a custom endpoint, which OpenBot can't check.",
    });

    const member = setupRows(
      { ...READY, model: { ...READY.model, verdict: "not_checked" } },
      { productName: PRODUCT, audience: "member" },
    );
    expect(row(member, "model")).toMatchObject({
      status: "not_checked",
      detail: "Set up, not checked yet.",
      fix: null,
    });
  });

  test("Intelligence that did not confirm the entitlement needs setup, with its own advice", () => {
    const refused = intelligenceFact(UNLICENSED);
    expect(refused.state).toBe("refused");
    const admin = setupRows(
      { ...READY, intelligence: refused },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(admin, "intelligence")).toMatchObject({
      status: "needs_setup",
      required: true,
      fix: null,
    });
    expect(row(admin, "intelligence").detail).toContain(
      "COPILOTKIT_LICENSE_TOKEN",
    );

    const member = setupRows(
      { ...READY, intelligence: refused },
      { productName: PRODUCT, audience: "member" },
    );
    expect(row(member, "intelligence").detail).toBe("Your admin sets this up.");
    expect(JSON.stringify(member)).not.toContain("COPILOTKIT_LICENSE_TOKEN");
  });

  test("Intelligence that could not be reached needs setup, and names its variables to an admin", () => {
    const rows = setupRows(
      { ...READY, intelligence: intelligenceFact(new Error("timeout")) },
      { productName: PRODUCT, audience: "admin" },
    );
    expect(row(rows, "intelligence")).toMatchObject({
      status: "needs_setup",
      detail:
        "OpenBot couldn't reach Intelligence, so conversations and memory may fail. Check again in a moment, or check its address and key.",
      fix: {
        kind: "env",
        names: [
          "INTELLIGENCE_API_URL",
          "INTELLIGENCE_GATEWAY_WS_URL",
          "INTELLIGENCE_API_KEY",
        ],
      },
    });
    expect(intelligenceFact(ENTITLED)).toEqual({ state: "ready" });
  });
});

describe("what the provider's answer means for the key in use now", () => {
  const rejected = {
    kind: "warning" as const,
    line: {
      type: "model-credential-rejected" as const,
      provider: "openai" as const,
      model: "gpt-5.6-terra",
      status: 401,
      fix: "replace it",
    },
  };

  test("an answer about this key is its verdict", () => {
    expect(
      modelVerdict(
        { outcome: { kind: "available" }, stamp: "environment" },
        "environment",
      ),
    ).toBe("available");
    expect(
      modelVerdict({ outcome: rejected, stamp: "environment" }, "environment"),
    ).toBe("refused_key");
    expect(
      modelVerdict(
        { outcome: { kind: "skipped" }, stamp: "environment" },
        "environment",
      ),
    ).toBe("cannot_check");
  });

  test("an answer about another key, no answer, or an unreadable one is not checked", () => {
    expect(
      modelVerdict(
        { outcome: rejected, stamp: "environment" },
        "credential:credential-2",
      ),
    ).toBe("not_checked");
    expect(modelVerdict(undefined, "environment")).toBe("not_checked");
    expect(
      modelVerdict(
        {
          outcome: {
            kind: "warning",
            line: {
              type: "model-check-unreadable",
              provider: "openai",
              model: "gpt-5.6-terra",
              fix: "often temporary",
            },
          },
          stamp: "environment",
        },
        "environment",
      ),
    ).toBe("not_checked");
  });
});

describe("where the model key comes from", () => {
  const credential = (overrides: Partial<CredentialStatus> = {}) =>
    ({
      id: "credential-1",
      kind: "model",
      provider: "openai",
      keyId: "openai-api-key",
      metadata: {},
      revokedAt: null,
      ...overrides,
    }) satisfies CredentialStatus;
  const reader = (list: CredentialStatus[]) => ({ list: async () => list });
  const base = {
    plan: false,
    provider: "openai" as const,
    keyId: "openai-api-key",
  };

  test("a plan, then the vault, then the environment, as the runtime reads them", async () => {
    expect(
      (
        await modelKeyOf({
          ...base,
          plan: true,
          credentials: reader([]),
          environment: {},
        })
      ).source,
    ).toBe("plan");
    expect(
      (
        await modelKeyOf({
          ...base,
          credentials: reader([credential()]),
          environment: { OPENAI_API_KEY: "sk-set" },
        })
      ).source,
    ).toBe("credential");
    expect(
      (
        await modelKeyOf({
          ...base,
          credentials: reader([]),
          environment: { OPENAI_API_KEY: "sk-set" },
        })
      ).source,
    ).toBe("environment");
    expect(
      (
        await modelKeyOf({
          ...base,
          credentials: reader([]),
          environment: { OPENAI_API_KEY: "  " },
        })
      ).source,
    ).toBeNull();
  });

  test("the stamp names the one key, so a rotated vault key is a new key", async () => {
    expect(
      await modelKeyOf({
        ...base,
        credentials: reader([credential({ id: "credential-7" })]),
        environment: { OPENAI_API_KEY: "sk-set" },
      }),
    ).toEqual({ source: "credential", stamp: "credential:credential-7" });
    expect(
      await modelKeyOf({
        ...base,
        credentials: reader([]),
        environment: { OPENAI_API_KEY: "sk-set" },
      }),
    ).toEqual({ source: "environment", stamp: "environment" });
  });

  test("a revoked key, another provider's key and another key id do not count", async () => {
    expect(
      (
        await modelKeyOf({
          ...base,
          credentials: reader([
            credential({ revokedAt: new Date() }),
            credential({ provider: "anthropic" }),
            credential({ keyId: "something-else" }),
            credential({ kind: "connector" }),
          ]),
          environment: {},
        })
      ).source,
    ).toBeNull();
  });
});

/** Every secret this server reads from its environment, each set to a value no row may contain. */
const SENTINELS = {
  INTELLIGENCE_API_KEY: "sentinel-intelligence-key-0f3a",
  COPILOTKIT_LICENSE_TOKEN: "sentinel-licence-token-91bc",
  OPENAI_API_KEY: "sentinel-openai-key-7d21",
  ANTHROPIC_API_KEY: "sentinel-anthropic-key-4e88",
  COMPOSIO_API_KEY: "sentinel-composio-key-2b6f",
  OPENTAG_SHARED_SECRET: "sentinel-opentag-secret-0123456789abcdef",
  COMPUTER_TOKEN: "sentinel-computer-token-5c90",
  SUPERVISOR_TOKEN: "sentinel-supervisor-token-a1d4",
  MANAGED_AGENT_TOKEN: "sentinel-managed-agent-token-66e2",
  GOOGLE_OAUTH_CLIENT_SECRET: "sentinel-google-secret-3f17",
  BETTER_AUTH_SECRET: "sentinel-better-auth-secret-long-enough-9a0b",
  AGENT_TOOL_TOKEN: "sentinel-agent-tool-token-8812",
  WORKER_SHARED_SECRET: "sentinel-worker-secret-c4e0",
};

/** One member and one admin, told apart by the roles the repository answers with. */
const PEOPLE = {
  member: {
    user: {
      id: "member-1",
      email: "member@openbot.test",
      name: "A Member",
      image: null,
    },
    roles: ["user"],
  },
  admin: {
    user: {
      id: "admin-1",
      email: "admin@openbot.test",
      name: "An Admin",
      image: null,
    },
    roles: ["admin"],
  },
} as const;

/**
 * The real route, mounted by `createApp`, with sources built from a real configuration. Only the
 * stores, Intelligence and the model provider are stand-ins.
 */
function appWith(input: {
  environment: Record<string, string | undefined>;
  who: keyof typeof PEOPLE;
  credentials?: CredentialStatus[];
  modelCheckAtBoot?: ModelCheckOutcome;
  /** What a "Check again" hears from the provider; counted in `checks`. */
  modelCheck?: () => ModelCheckOutcome;
  entitlements?: () => Promise<RuntimeEntitlementResponse>;
  computer?: boolean;
  computerCheck?: () => Promise<"ready" | "needs_setup" | "not_checked">;
  apps?: boolean;
  chat?: boolean;
  signedIn?: boolean;
}) {
  const config = loadConfig(testEnvironment(input.environment));
  const person = PEOPLE[input.who];
  const counts = { checks: 0 };
  const setup = createSetupSources({
    productName: PRODUCT,
    config,
    environment: testEnvironment(input.environment),
    model: {
      provider: "openai",
      keyId: "openai-api-key",
      defaultModel: "gpt-5.6-terra",
      plan: false,
      check: async () => {
        counts.checks += 1;
        return input.modelCheck?.() ?? { kind: "available" };
      },
    },
    credentials: { list: async () => input.credentials ?? [] },
    ...(input.modelCheckAtBoot
      ? {
          modelCheckAtBoot: Promise.resolve({
            outcome: input.modelCheckAtBoot,
            stamp: "environment",
          }),
        }
      : {}),
    entitlements: input.entitlements ?? (async () => ENTITLED),
    computer: input.computer ?? Boolean(config.computer),
    computerCheck: input.computerCheck ?? (async () => "ready"),
    apps: { configured: input.apps ?? false, provider: "composio" },
    chat: input.chat ?? false,
  });
  const app = createApp(
    config,
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () =>
          input.signedIn === false ? null : { user: person.user },
      },
    } as never,
    { rolesForUser: async () => [...person.roles] },
    /*
     * Positions 4-34 are the other stores; `coworker` is 35. Every parameter from 4 on is optional,
     * so a wrong count is a silent type-check pass: see onboarding-routes.test.ts.
     */
    ...(Array.from({ length: 31 }) as never[]),
    { setup } as never,
  );
  return Object.assign(app, { counts });
}

async function checklistFrom(
  app: ReturnType<typeof appWith>,
  method: "GET" | "POST" = "GET",
) {
  const response = await app.request(
    method === "GET"
      ? "http://openbot.local/api/setup"
      : "http://openbot.local/api/setup/check",
    { method },
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  return {
    text,
    checklist: (JSON.parse(text) as { checklist: SetupChecklist }).checklist,
  };
}

describe("GET /api/setup", () => {
  test("asks who is signed in", async () => {
    const app = appWith({ environment: {}, who: "member", signedIn: false });
    const response = await app.request("http://openbot.local/api/setup");
    expect(response.status).toBe(401);
  });

  test("set configuration reads Ready, row by row", async () => {
    const { checklist } = await checklistFrom(
      appWith({
        who: "admin",
        environment: { OPENAI_API_KEY: "sk-set" },
        modelCheckAtBoot: { kind: "available" },
        computer: true,
        apps: true,
        chat: true,
      }),
    );
    expect(checklist.audience).toBe("admin");
    expect(
      checklist.rows.filter((candidate) => !candidate.ready).map((c) => c.id),
    ).toEqual([]);
  });

  test("unset configuration reads Needs setup, with each fix", async () => {
    const { checklist } = await checklistFrom(
      appWith({
        who: "admin",
        environment: { OPENAI_API_KEY: undefined },
        computer: false,
      }),
    );
    const gaps = Object.fromEntries(
      checklist.rows
        .filter((candidate) => !candidate.ready)
        .map((candidate) => [candidate.id, candidate.fix?.kind ?? null]),
    );
    expect(gaps).toEqual({
      model: "env",
      computer: "env",
      apps: "env",
      chat: "env",
    });
    // Intelligence answered ready and active, so that row is the one that holds.
    expect(row(checklist.rows, "intelligence").ready).toBe(true);
  });

  test("Intelligence is read from its entitlement answer, not from its address being set", async () => {
    const unlicensed = await checklistFrom(
      appWith({
        who: "admin",
        environment: {},
        entitlements: async () => UNLICENSED,
      }),
    );
    expect(row(unlicensed.checklist.rows, "intelligence").status).toBe(
      "needs_setup",
    );

    const down = await checklistFrom(
      appWith({
        who: "admin",
        environment: {},
        entitlements: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    expect(row(down.checklist.rows, "intelligence")).toMatchObject({
      status: "needs_setup",
      fix: { kind: "env" },
    });
  });

  test("a key added since the boot check is not checked until Check again asks", async () => {
    const app = appWith({
      who: "admin",
      environment: { OPENAI_API_KEY: "sk-set" },
      modelCheckAtBoot: { kind: "available" },
      credentials: [
        {
          id: "credential-9",
          kind: "model",
          provider: "openai",
          keyId: "openai-api-key",
          metadata: {},
          revokedAt: null,
        },
      ],
      modelCheck: () => ({
        kind: "warning",
        line: {
          type: "model-credential-rejected",
          provider: "openai",
          model: "gpt-5.6-terra",
          status: 401,
          fix: "replace it",
        },
      }),
    });

    const before = await checklistFrom(app);
    expect(row(before.checklist.rows, "model").status).toBe("not_checked");
    expect(app.counts.checks).toBe(0);

    const after = await checklistFrom(app, "POST");
    expect(app.counts.checks).toBe(1);
    expect(row(after.checklist.rows, "model")).toMatchObject({
      status: "needs_setup",
      detail: "OpenAI refused the model key, so OpenBot can't answer.",
    });

    // A second press inside the interval is answered from the first, with no second call out.
    expect(RECHECK_INTERVAL_MS).toBeGreaterThan(1000);
    await checklistFrom(app, "POST");
    expect(app.counts.checks).toBe(1);

    // And plain reads after it keep the answer.
    const read = await checklistFrom(app);
    expect(row(read.checklist.rows, "model").status).toBe("needs_setup");
  });

  test("Check again asks Intelligence again too", async () => {
    let answers = 0;
    const app = appWith({
      who: "admin",
      environment: {},
      entitlements: async () => {
        answers += 1;
        return answers === 1 ? UNLICENSED : ENTITLED;
      },
    });
    const before = await checklistFrom(app);
    expect(row(before.checklist.rows, "intelligence").status).toBe(
      "needs_setup",
    );
    const after = await checklistFrom(app, "POST");
    expect(row(after.checklist.rows, "intelligence").status).toBe("ready");
  });

  test("Check again asks who is signed in", async () => {
    const app = appWith({ environment: {}, who: "member", signedIn: false });
    const response = await app.request("http://openbot.local/api/setup/check", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  test("the boot verdict on an environment key is repeated", async () => {
    const { checklist } = await checklistFrom(
      appWith({
        who: "admin",
        environment: { OPENAI_API_KEY: "sk-set" },
        modelCheckAtBoot: {
          kind: "warning",
          line: {
            type: "model-credential-rejected",
            provider: "openai",
            model: "gpt-5.6-terra",
            status: 401,
            fix: "replace it",
          },
        },
      }),
    );
    expect(row(checklist.rows, "model")).toMatchObject({
      ready: false,
      detail: "OpenAI refused the model key, so OpenBot can't answer.",
    });
  });

  test("a member is answered as a member, with no variable names", async () => {
    const { checklist, text } = await checklistFrom(
      appWith({
        who: "member",
        environment: { OPENAI_API_KEY: undefined },
        entitlements: async () => UNLICENSED,
      }),
    );
    expect(checklist.audience).toBe("member");
    expect(row(checklist.rows, "model")).toMatchObject({
      required: true,
      ready: false,
      detail: "Your admin sets this up.",
      fix: null,
    });
    expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}/);
  });

  test.each([
    ["an admin", "admin"],
    ["a member", "member"],
  ] as const)("no secret reaches %s, set or not", async (_label, who) => {
    for (const environment of [
      SENTINELS,
      { ...SENTINELS, OPENAI_API_KEY: undefined, COMPOSIO_API_KEY: undefined },
    ]) {
      const app = appWith({
        who,
        environment: {
          ...environment,
          AGENT_COMPUTER_URL: "http://localhost:4100",
        },
        entitlements: async () => UNLICENSED,
        credentials: [
          {
            id: "credential-1",
            kind: "model",
            provider: "openai",
            keyId: "openai-api-key",
            metadata: { note: "statuses carry no secret" },
            revokedAt: null,
          },
        ],
        apps: true,
        chat: true,
      });
      // The plain read, and the answer after Check again asked both services.
      const text = [
        (await checklistFrom(app)).text,
        (await checklistFrom(app, "POST")).text,
      ].join("\n");
      for (const sentinel of Object.values(SENTINELS)) {
        expect(text).not.toContain(sentinel);
      }
      // Nor the halves a mask would leave: the first and last few characters of each.
      for (const sentinel of Object.values(SENTINELS)) {
        expect(text).not.toContain(sentinel.slice(-6));
      }
    }
  });
});

test("healthy sequential computer pushes keep their own deadlines in the checklist", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const recheckStarted = Promise.withResolvers<void>();
  const replies = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ];
  const requested: string[] = [];
  let listings = 0;
  let entitlements = 0;
  jest.useFakeTimers();
  try {
    const app = appWith({
      environment: {},
      who: "admin",
      computer: true,
      entitlements: async () => {
        if (++entitlements === 2) recheckStarted.resolve();
        return ENTITLED;
      },
      computerCheck: createComputerCheck({
        provider: {
          list: async () => {
            listings += 1;
            return [
              {
                key: { kind: "bot", botId: "one" },
                status: "running",
                url: "http://one.local",
              },
              {
                key: { kind: "bot", botId: "two" },
                status: "running",
                url: "http://two.local",
              },
              {
                key: { kind: "bot", botId: "sleeping" },
                status: "stopped",
                url: "http://sleep.local",
              },
            ];
          },
        },
        controls: () => ({
          policyForBot: async () => ({ mode: "allow_all", rules: [] }),
        }),
        fetchImpl: Object.assign(
          async (url: string | URL | Request) => {
            requested.push(String(url));
            const index = requested.length - 1;
            (index === 0 ? first : second).resolve();
            return replies[index]!.promise;
          },
          { preconnect() {} },
        ),
      }),
    });
    const answer = checklistFrom(app);
    await first.promise;
    const recheck = checklistFrom(app, "POST");
    await recheckStarted.promise;
    jest.advanceTimersByTime(3_000);
    replies[0]!.resolve(new Response(null, { status: 204 }));
    await second.promise;
    jest.advanceTimersByTime(3_000);
    replies[1]!.resolve(new Response(null, { status: 204 }));
    expect(row((await answer).checklist.rows, "computer").status).toBe("ready");
    expect(row((await recheck).checklist.rows, "computer").status).toBe(
      "ready",
    );
    expect(listings).toBe(1);
    expect(requested).toEqual([
      "http://one.local/egress-policy",
      "http://two.local/egress-policy",
    ]);
  } finally {
    for (const reply of replies) reply.resolve(new Response());
    jest.useRealTimers();
  }
});

test("a configured computer that refuses its policy is Needs setup, then recovers on recheck", async () => {
  let ready = false;
  const tokens: Array<string | null> = [];
  const app = appWith({
    environment: {},
    who: "admin",
    computer: true,
    computerCheck: createComputerCheck({
      provider: {
        list: async () => [
          {
            key: { kind: "bot", botId: "one" },
            status: "running",
            url: "http://one.local",
          },
        ],
      },
      controls: () => ({
        policyForBot: async () => ({ mode: "allow_all", rules: [] }),
      }),
      token: "configured-computer-token",
      fetchImpl: Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          tokens.push(
            new Headers(init?.headers).get("x-openbot-computer-token"),
          );
          return new Response(null, { status: ready ? 204 : 401 });
        },
        { preconnect() {} },
      ),
    }),
  });
  const response = await app.request("/api/setup");
  const first = await response.json();
  expect(row(first.checklist.rows, "computer").status).toBe("needs_setup");
  ready = true;
  const after = await app.request("/api/setup/check", {
    method: "POST",
  });
  expect(row((await after.json()).checklist.rows, "computer").status).toBe(
    "ready",
  );
  expect(tokens).toEqual([
    "configured-computer-token",
    "configured-computer-token",
  ]);
});

test("a person's computer is asked which Bots it carries, and each takes its own policy", async () => {
  const requested: string[] = [];
  const policies: string[] = [];
  const app = appWith({
    environment: {},
    who: "admin",
    computer: true,
    computerCheck: createComputerCheck({
      provider: {
        list: async () => [
          {
            key: { kind: "person", personId: "alice" },
            status: "running",
            url: "http://alice.local",
          },
        ],
      },
      controls: () => ({
        policyForBot: async (botId) => {
          policies.push(botId);
          return { mode: "allow_all", rules: [] };
        },
      }),
      fetchImpl: Object.assign(
        async (url: string | URL | Request) => {
          requested.push(String(url));
          return String(url).endsWith("/computers")
            ? Response.json({
                computers: [{ botId: "writer" }, { botId: "researcher" }],
              })
            : new Response(null, { status: 204 });
        },
        { preconnect() {} },
      ),
    }),
  });
  const answer = await app.request("/api/setup");
  expect(row((await answer.json()).checklist.rows, "computer").status).toBe(
    "ready",
  );
  expect(policies).toEqual(["writer", "researcher"]);
  expect(requested).toEqual([
    "http://alice.local/computers",
    "http://alice.local/egress-policy",
    "http://alice.local/egress-policy",
  ]);
});

test.each(["list", "policy", "push"] as const)(
  "a hung computer %s fails the checklist without stacking rechecks",
  async (stage) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const enter = async (step: typeof stage) => {
      calls.push(step);
      if (step === stage) {
        started.resolve();
        await release.promise;
      }
    };
    jest.useFakeTimers();
    try {
      const app = appWith({
        environment: {},
        who: "admin",
        computer: true,
        computerCheck: createComputerCheck({
          provider: {
            list: async () => {
              await enter("list");
              return [
                {
                  key: { kind: "bot", botId: "one" },
                  status: "running",
                  url: "http://one.local",
                },
              ];
            },
          },
          controls: () => ({
            policyForBot: async () => {
              await enter("policy");
              return { mode: "allow_all", rules: [] };
            },
          }),
          fetchImpl: Object.assign(
            async () => {
              await enter("push");
              return new Response(null, { status: 204 });
            },
            { preconnect() {} },
          ),
        }),
      });
      await started.promise;
      jest.advanceTimersByTime(5_000);
      expect(
        row((await checklistFrom(app)).checklist.rows, "computer").status,
      ).toBe("needs_setup");
      expect(
        row((await checklistFrom(app, "POST")).checklist.rows, "computer")
          .status,
      ).toBe("needs_setup");
      expect(calls).toEqual(
        ["list", "policy", "push"].slice(
          0,
          ["list", "policy", "push"].indexOf(stage) + 1,
        ),
      );
    } finally {
      release.resolve();
      jest.useRealTimers();
    }
  },
);

test("a configured computer without a reachability verdict is not yet checked", () => {
  const { computerStatus: _, ...facts } = READY;
  expect(
    row(
      setupRows(facts, { productName: PRODUCT, audience: "admin" }),
      "computer",
    ).status,
  ).toBe("not_checked");
});
