import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  chatModelIds,
  createModelCatalogue,
  createModelRoutes,
  modelLabel,
  modelsUrl,
  modelVendor,
} from "../src/model-catalogue";

const KEY = "sk-proj-not-a-real-key-0123456789";

/** A provider answering one listing, counting how often it was asked. */
function provider(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

const openAIListing = (ids: string[]) => ({
  object: "list",
  data: ids.map((id, index) => ({ id, object: "model", created: index })),
});

describe("which of OpenAI's models a person can chat with", () => {
  test("keeps current chat models and drops everything else OpenAI lists", () => {
    const listed = [
      "gpt-5.5",
      "gpt-5.5-2026-04-23",
      "gpt-5.5-pro",
      "gpt-5.6-terra",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "o4-mini",
      "o3",
      // Not chat models.
      "text-embedding-3-large",
      "gpt-image-2",
      "gpt-4o-mini-tts",
      "gpt-4o-transcribe",
      "gpt-realtime-2",
      "gpt-audio-mini",
      "whisper-1",
      "tts-1-hd",
      "omni-moderation-latest",
      "sora-2",
      "dall-e-3",
      "gpt-4o-search-preview",
      "o3-deep-research",
      "computer-use-preview",
      "gpt-live-1",
      "gpt-realtime-translate",
      "chatgpt-image-latest",
      // Chat models a Bot should not be put on.
      "gpt-5-chat-latest",
      "chat-latest",
      "gpt-5.3-codex",
      "gpt-3.5-turbo",
      "gpt-4",
      "gpt-4-turbo",
      "gpt-3.5-turbo-instruct",
      "babbage-002",
      "davinci-002",
      "o1",
      "o1-pro",
      // Dated snapshots of models already listed under their own name.
      "gpt-4o-2024-08-06",
      "gpt-4-0613",
    ];
    expect(chatModelIds(listed, { officialOpenAI: true })).toEqual([
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-terra",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "o4-mini",
      "o3",
    ]);
  });

  test("a gateway's list is its own choice, so only what can never chat is dropped", () => {
    // A router such as switchback lists exactly the models it routes, under its own names.
    expect(
      chatModelIds(
        [
          "openai/gpt-5.5",
          "anthropic/claude-sonnet-5-5",
          "fast",
          "llama3.3:70b",
          "text-embedding-3-small",
          "gpt-4o-2024-08-06",
        ],
        { officialOpenAI: false },
      ),
    ).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-5-5",
      "fast",
      "llama3.3:70b",
      "gpt-4o-2024-08-06",
    ]);
  });
});

describe("what a model is called in the picker", () => {
  test("OpenAI's names read as names", () => {
    expect(modelLabel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(modelLabel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
    expect(modelLabel("gpt-4o")).toBe("GPT-4o");
    expect(modelLabel("gpt-5-pro")).toBe("GPT-5 Pro");
    expect(modelLabel("o4-mini")).toBe("o4-mini");
  });

  test("a gateway's own names are left as they are", () => {
    expect(modelLabel("openai/gpt-5.5")).toBe("openai/gpt-5.5");
    expect(modelLabel("fast")).toBe("fast");
  });
});

describe("who makes a model, for the mark beside it", () => {
  test("a bare name is matched on the vendor's families", () => {
    expect(modelVendor("gpt-5.5")).toBe("openai");
    expect(modelVendor("o4-mini")).toBe("openai");
    expect(modelVendor("claude-sonnet-5-5")).toBe("anthropic");
    expect(modelVendor("gemini-3.8-flash")).toBe("google");
    expect(modelVendor("grok-4.7")).toBe("xai");
    expect(modelVendor("llama3.3:70b")).toBe("meta");
  });

  test("a gateway's namespaced name says so outright", () => {
    expect(modelVendor("anthropic/claude-opus-5-5")).toBe("anthropic");
    expect(modelVendor("x-ai/grok-4")).toBe("xai");
    expect(modelVendor("meta-llama/llama-4")).toBe("meta");
  });

  test("an alias that names no family has no vendor", () => {
    expect(modelVendor("fast")).toBeUndefined();
  });
});

describe("where the listing is read from", () => {
  test("OpenAI's own API when no base URL is set", () => {
    expect(modelsUrl("openai", {})).toBe("https://api.openai.com/v1/models");
  });

  test("a gateway's base URL, with or without its version segment", () => {
    expect(
      modelsUrl("openai", { OPENAI_BASE_URL: "http://127.0.0.1:4011/v1/" }),
    ).toBe("http://127.0.0.1:4011/v1/models");
    expect(
      modelsUrl("openai", { OPENAI_BASE_URL: "http://127.0.0.1:4011" }),
    ).toBe("http://127.0.0.1:4011/v1/models");
  });

  test("Anthropic's own API, or its configured base", () => {
    expect(modelsUrl("anthropic", {})).toBe(
      "https://api.anthropic.com/v1/models?limit=1000",
    );
    expect(
      modelsUrl("anthropic", { ANTHROPIC_BASE_URL: "https://proxy.test/v1" }),
    ).toBe("https://proxy.test/v1/models?limit=1000");
  });
});

describe("the catalogue a deployment offers", () => {
  test("lists the provider's chat models, newest first, with the deployment's model as the default", async () => {
    const { fetcher, calls } = provider(
      openAIListing([
        "gpt-4o",
        "text-embedding-3-small",
        "gpt-5.5",
        "gpt-6-sol",
      ]),
    );
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });

    expect(await catalogue.read()).toEqual({
      provider: "openai",
      default: "gpt-5.5",
      choosable: true,
      models: [
        { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
        { id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" },
        { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
      ],
    });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("asks the provider once and answers from memory after that", async () => {
    const { fetcher, calls } = provider(openAIListing(["gpt-5.5", "gpt-4o"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    await Promise.all([catalogue.read(), catalogue.read()]);
    await catalogue.read();
    expect(calls).toHaveLength(1);
  });

  test("asks again once what it read has gone stale", async () => {
    const { fetcher, calls } = provider(openAIListing(["gpt-5.5", "gpt-4o"]));
    let clock = 0;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      now: () => clock,
      ttlMs: 1_000,
    });
    await catalogue.read();
    clock = 1_001;
    await catalogue.read();
    expect(calls).toHaveLength(2);
  });

  test("Anthropic is asked with its own headers and its display names are kept", async () => {
    const { fetcher, calls } = provider({
      data: [
        {
          id: "claude-haiku-5-5",
          display_name: "Claude Haiku 5.5",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "claude-opus-5-5",
          display_name: "Claude Opus 5.5",
          created_at: "2026-06-01T00:00:00Z",
        },
        {
          id: "claude-sonnet-5-5",
          display_name: "Claude Sonnet 5.5",
          created_at: "2026-05-15T00:00:00Z",
        },
      ],
    });
    const catalogue = createModelCatalogue({
      model: { provider: "anthropic", defaultModel: "claude-sonnet-5-5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });

    expect((await catalogue.read()).models).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", vendor: "anthropic" },
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        vendor: "anthropic",
      },
      {
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        vendor: "anthropic",
      },
    ]);
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("a gateway that needs no key is asked without one", async () => {
    const { fetcher, calls } = provider(openAIListing(["fast", "smart"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "fast" },
      apiKey: async () => null,
      environment: { OPENAI_BASE_URL: "http://127.0.0.1:4011/v1" },
      fetch: fetcher,
    });
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "smart",
      "fast",
    ]);
    expect(calls[0]?.headers).toEqual({});
  });

  test("the deployment's model is offered even when the provider does not list it", async () => {
    const { fetcher } = provider(openAIListing(["gpt-4o"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    expect((await catalogue.read()).models).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" },
      { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
    ]);
  });

  test("a provider that cannot be read leaves only the deployment's model, and nothing to choose", async () => {
    const { fetcher } = provider({ error: "nope" }, 500);
    const logged: string[] = [];
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: (line) => logged.push(line),
    });
    expect(await catalogue.read()).toEqual({
      provider: "openai",
      default: "gpt-5.5",
      choosable: false,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" }],
    });
    expect(logged.join("\n")).toContain("model-list-unreadable");
    // Never the key.
    expect(logged.join("\n")).not.toContain(KEY);
  });

  test("a plan picks its own model, so there is nothing to choose and nobody is asked", async () => {
    const { fetcher, calls } = provider(openAIListing(["gpt-5.5", "gpt-4o"]));
    const catalogue = createModelCatalogue({
      model: {
        provider: "openai",
        defaultModel: "gpt-5.5",
        plan: { kind: "claude" } as never,
      },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    expect((await catalogue.read()).choosable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("an admin's allowlist narrows what is offered, and is read every time", async () => {
    const { fetcher } = provider(
      openAIListing(["gpt-4o", "gpt-5.5", "gpt-6-sol"]),
    );
    let allowlist = {
      enabled: true,
      models: ["openai/gpt-5.5", "openai/gpt-4o"],
    };
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      allowlist: () => allowlist,
    });
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-4o",
    ]);
    allowlist = { enabled: false, models: [] };
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-5.5",
      "gpt-4o",
    ]);
  });

  test("while the admin has picking off there is nothing to choose", async () => {
    const { fetcher } = provider(openAIListing(["gpt-4o", "gpt-5.5"]));
    let on = false;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      enabled: () => on,
    });
    expect((await catalogue.read()).choosable).toBe(false);
    on = true;
    expect((await catalogue.read()).choosable).toBe(true);
  });

  test("allows only what it offers", async () => {
    const { fetcher } = provider(openAIListing(["gpt-4o", "gpt-5.5"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      allowlist: () => ({ enabled: true, models: ["openai/gpt-5.5"] }),
    });
    expect(await catalogue.allows("gpt-5.5")).toBe(true);
    expect(await catalogue.allows("gpt-4o")).toBe(false);
    expect(await catalogue.allows("text-embedding-3-small")).toBe(false);
    expect(await catalogue.allows("anthropic/claude-opus-5-5")).toBe(false);
  });

  test("an admin sees every model the listing offers, whatever the allowlist says", async () => {
    const { fetcher } = provider(
      openAIListing(["gpt-4o", "gpt-5.5", "gpt-6-sol"]),
    );
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      allowlist: () => ({ enabled: true, models: ["openai/gpt-5.5"] }),
      enabled: () => false,
    });
    expect(await catalogue.available()).toEqual({
      provider: "openai",
      default: "gpt-5.5",
      listed: true,
      models: [
        { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
        { id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" },
        { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
      ],
    });
  });

  test("an unreadable listing leaves an admin only the deployment's model", async () => {
    const { fetcher } = provider({ error: "down" }, 503);
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: () => undefined,
    });
    expect(await catalogue.available()).toEqual({
      provider: "openai",
      default: "gpt-5.5",
      listed: false,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" }],
    });
  });
});

describe("GET /api/models/available", () => {
  const catalogue = createModelCatalogue({
    model: { provider: "openai", defaultModel: "gpt-5.5" },
    apiKey: async () => KEY,
    environment: {},
    fetch: provider(openAIListing(["gpt-4o", "gpt-5.5"])).fetcher,
    allowlist: () => ({ enabled: true, models: ["openai/gpt-5.5"] }),
  });
  const as =
    (role: "admin" | "user"): MiddlewareHandler<{ Variables: AppVariables }> =>
    async (context, next) => {
      context.set("actor", { id: "someone", role } as AppVariables["actor"]);
      await next();
    };

  test("answers an admin with the whole listing", async () => {
    const response = await createModelRoutes(catalogue, as("admin")).request(
      "/available",
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { models: { id: string }[] }).models.map(
        (model) => model.id,
      ),
    ).toEqual(["gpt-5.5", "gpt-4o"]);
  });

  test("refuses anybody else", async () => {
    const response = await createModelRoutes(catalogue, as("user")).request(
      "/available",
    );
    expect(response.status).toBe(403);
  });
});
