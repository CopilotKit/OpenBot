import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { planModelForEnvironment } from "../src/agents/plan-model";
import type { AppVariables } from "../src/auth/guards";
import {
  chatModelIds,
  createModelCatalogue,
  createModelRoutes,
  isModelUnavailableMessage,
  type ModelOption,
  modelLabel,
  modelsUrl,
  modelVendor,
  REFRESH_MS,
  reportModelRejected,
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
    // OpenRouter's moving aliases carry a tilde before the vendor.
    expect(modelVendor("~openai/gpt-sol-latest")).toBe("openai");
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

  test("Google's compatibility API, which ends in its own version path", () => {
    expect(
      modelsUrl("openai", {
        OPENAI_BASE_URL:
          "https://generativelanguage.googleapis.com/v1beta/openai/",
      }),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });
});

/*
 * The listings below are the providers' own answers, captured on 2026-11-05 from OpenAI's, Anthropic's,
 * Google's and xAI's model endpoints, and models.dev's `api.json` cut down to those vendors' models.
 * See tests/fixtures/model-listings/.
 */
const FIXTURES = `${import.meta.dir}/fixtures/model-listings/`;
const fixture = (name: string) => Bun.file(FIXTURES + name).json();
const MODELS_DEV = "https://models.dev/api.json";

/**
 * The web as the catalogue sees it: each URL answers what its owner answers, and every request is
 * counted. A route can be swapped mid-test, which is how a provider ships or retires a model.
 */
function web(routes: Record<string, unknown>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const answers = new Map(Object.entries(routes));
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const answer = answers.get(href);
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (answer instanceof Response) return answer.clone();
    return Response.json(answer);
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    set: (url: string, answer: unknown) => answers.set(url, answer),
    asked: (url: string) => calls.filter((call) => call.url === url).length,
  };
}

const efforts = (catalogue: { models: ModelOption[] }, id: string) =>
  catalogue.models.find((model) => model.id === id);

describe("the default and the thinking levels, from the providers' own data", () => {
  test("OpenAI: the middle of the current line is GPT-6.1 Terra, and models.dev says how each thinks", async () => {
    const { fetcher } = web({
      "https://api.openai.com/v1/models": await fixture("openai-models.json"),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      // The configured model is stale on purpose: the middle replaces it.
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("openai");
    expect(read.default).toBe("gpt-6.1-terra");
    expect(read.models[0]?.id).toBe("gpt-6.1-terra");
    expect(efforts(read, "gpt-6.1-terra")).toEqual({
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    });
    // GPT-6.1 Sol takes no `none`; GPT-4o is not a reasoning model and offers no effort at all.
    expect(efforts(read, "gpt-6.1-sol")?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(efforts(read, "gpt-4o")).toEqual({
      id: "gpt-4o",
      label: "GPT-4o",
      vendor: "openai",
    });
    // Past its shutdown date in OpenAI's own listing would drop it; image, audio and codex never chat.
    const ids = read.models.map((model) => model.id);
    expect(ids).not.toContain("gpt-image-2");
    expect(ids).not.toContain("gpt-realtime-2");
    expect(ids).not.toContain("gpt-5.3-codex");
  });

  test("Anthropic: Sonnet is the middle line, and its efforts come from Anthropic's own listing", async () => {
    const { fetcher, calls } = web({
      "https://api.anthropic.com/v1/models?limit=1000": await fixture(
        "anthropic-models.json",
      ),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "anthropic", defaultModel: "claude-sonnet-4-6" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("anthropic");
    expect(read.default).toBe("claude-sonnet-5-5");
    expect(efforts(read, "claude-sonnet-5-5")).toEqual({
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      vendor: "anthropic",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    // Anthropic says Sonnet 4.6 takes no `xhigh`, and Haiku 4.5 no effort at all.
    expect(efforts(read, "claude-sonnet-4-6")?.efforts).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(efforts(read, "claude-haiku-4-5-20251001")).toEqual({
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      vendor: "anthropic",
    });
    const asked = calls.find((call) => call.url.includes("anthropic.com"));
    expect(asked?.headers["x-api-key"]).toBe(KEY);
    expect(asked?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("Google, through its OpenAI-compatible API: Flash is the middle, and what cannot chat is left out", async () => {
    const base = "https://generativelanguage.googleapis.com/v1beta/openai/";
    const { fetcher } = web({
      [`${base}models`]: await fixture("gemini-openai-models.json"),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gemini-2.5-flash" },
      apiKey: async () => KEY,
      environment: { OPENAI_BASE_URL: base, BOT_MODEL: "gemini-2.5-flash" },
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("google");
    expect(read.default).toBe("gemini-3.8-flash");
    expect(efforts(read, "gemini-3.8-flash")).toEqual({
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      vendor: "google",
      efforts: ["low", "medium", "high"],
    });
    const ids = read.models.map((model) => model.id);
    // Google's own `models/` prefix is dropped: the bare name is what a run sends.
    expect(ids.every((id) => !id.startsWith("models/"))).toBe(true);
    for (const never of [
      "gemini-2.5-flash-preview-tts",
      "gemini-3.1-flash-image",
      "lyria-3.5",
      "gemini-embedding-2",
      "gemini-3.8-live",
      "gemini-robotics-er-2-preview",
      "deep-research-preview-04-2026",
      "antigravity-preview-latest",
      "nano-banana-pro-preview",
    ])
      expect(ids).not.toContain(never);
  });

  test("xAI: its own listing says each model's efforts and default effort", async () => {
    const { fetcher, calls } = web({
      "https://api.x.ai/v1/language-models": await fixture(
        "xai-language-models.json",
      ),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "grok-4.5" },
      apiKey: async () => KEY,
      environment: {
        OPENAI_BASE_URL: "https://api.x.ai/v1",
        BOT_MODEL: "grok-4.5",
      },
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("xai");
    // One current line (Grok), so its newest.
    expect(read.default).toBe("grok-4.7");
    expect(efforts(read, "grok-4.7")).toEqual({
      id: "grok-4.7",
      label: "Grok 4.7",
      vendor: "xai",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
    });
    expect(efforts(read, "grok-4.3")).toMatchObject({
      efforts: ["none", "low", "medium", "high", "xhigh"],
      defaultEffort: "low",
    });
    const ids = read.models.map((model) => model.id);
    expect(ids).not.toContain("grok-imagine-video-1.5");
    expect(ids).not.toContain("grok-4.20-multi-agent-0309");
    expect(
      calls.find((call) => call.url.includes("x.ai"))?.headers.authorization,
    ).toBe(`Bearer ${KEY}`);
  });

  test("a ChatGPT plan lists what its harness says the plan can use, with the plan's own efforts", async () => {
    const harness = "http://agent-harness:4206/";
    const { fetcher, calls } = web({
      "http://agent-harness:4206/models": {
        object: "list",
        data: [
          {
            id: "gpt-6.1-terra",
            label: "GPT-6.1 Terra",
            efforts: ["low", "medium", "high", "xhigh"],
            default_effort: "medium",
            priority: 1,
          },
          {
            id: "gpt-6.1-sol",
            label: "GPT-6.1 Sol",
            efforts: ["low", "medium", "high", "xhigh"],
            default_effort: "medium",
            priority: 2,
          },
          {
            id: "gpt-6-luna",
            label: "GPT-6 Luna",
            efforts: ["low", "medium", "high"],
            default_effort: "low",
            priority: 3,
          },
        ],
      },
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: {
        provider: "openai",
        defaultModel: "gpt-5.5",
        plan: {
          provider: "chatgpt",
          endpoint: new URL(harness),
          token: "managed-token",
        },
      },
      apiKey: async () => null,
      environment: {},
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("chatgpt");
    // Never gpt-5.5, which the plan does not offer: the middle of what it does.
    expect(read.default).toBe("gpt-6.1-terra");
    expect(read.models.map((model) => model.id)).not.toContain("gpt-5.5");
    expect(efforts(read, "gpt-6-luna")).toMatchObject({
      efforts: ["low", "medium", "high"],
      defaultEffort: "low",
    });
    expect(
      calls.find((call) => call.url.includes("agent-harness"))?.headers[
        "x-openbot-agent-token"
      ],
    ).toBe("managed-token");
    // A run on the default is sent the plan's model, never the stale configured one.
    expect(await catalogue.choose(null)).toEqual({
      model: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      listed: true,
    });
  });

  /*
   * The environment OpenBot Desktop writes for a Claude plan, turned into the plan the way the server
   * does at boot. `plan.token` is MANAGED_AGENT_TOKEN, the harness's own secret: sent to Anthropic as
   * the bearer, the listing came back 401 and no Claude plan ever had a model picker.
   */
  const OAUTH = "synthetic-claude-plan-oauth-token";
  const MANAGED = "managed-agent-token-for-the-harness-only";
  const claudePlanEnvironment = {
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot-agent-claude-sdk:1.0.0",
    PICKED_HARNESS_URL: "http://agent-harness:4206",
    MANAGED_AGENT_TOKEN: MANAGED,
  };

  /** Anthropic as it answers a bearer: the listing for the plan's OAuth token, 401 for anything else. */
  async function anthropicForPlan() {
    const listing = await fixture("anthropic-models.json");
    const site = web({ [MODELS_DEV]: await fixture("models-dev-api.json") });
    const fetcher = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const answer = await site.fetcher(url, init);
      if (!String(url).startsWith("https://api.anthropic.com/")) return answer;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return headers.authorization === `Bearer ${OAUTH}` &&
        headers["anthropic-beta"]?.includes("oauth-2025-04-20")
        ? Response.json(listing)
        : Response.json(
            {
              type: "error",
              error: {
                type: "authentication_error",
                message: "Invalid bearer token",
              },
            },
            { status: 401 },
          );
    }) as typeof fetch;
    return { fetcher, calls: site.calls };
  }

  test("a Claude plan's models are listed with the plan's OAuth token, so there is a model to pick", async () => {
    const plan = planModelForEnvironment(claudePlanEnvironment);
    const { fetcher, calls } = await anthropicForPlan();
    const lines: string[] = [];
    const catalogue = createModelCatalogue({
      model: { provider: "anthropic", defaultModel: "claude-sonnet-5-5", plan },
      apiKey: async () => null,
      environment: claudePlanEnvironment,
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    const read = await catalogue.read();
    expect(read.source).toBe("claude");
    // More than one model is what shows the conversation's model picker.
    expect(read.models.length).toBeGreaterThan(1);
    expect(read.default).toBe("claude-sonnet-5-5");
    expect(lines.filter((line) => line.includes("model-list"))).toEqual([]);
    const asked = calls.filter((call) => call.url.includes("anthropic.com"));
    expect(asked.length).toBeGreaterThan(0);
    for (const call of asked) {
      expect(call.headers.authorization).toBe(`Bearer ${OAUTH}`);
      expect(call.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(JSON.stringify(call.headers)).not.toContain(MANAGED);
    }
  });

  test("OpenBot's harness token never leaves for Anthropic, even where it is all there is", async () => {
    // A mis-written environment whose only token is the harness's own: nothing is asked at all.
    const environment = {
      ...claudePlanEnvironment,
      CLAUDE_CODE_OAUTH_TOKEN: MANAGED,
    };
    const plan = planModelForEnvironment(environment);
    const { fetcher, calls } = await anthropicForPlan();
    const lines: string[] = [];
    const catalogue = createModelCatalogue({
      model: { provider: "anthropic", defaultModel: "claude-sonnet-5-5", plan },
      apiKey: async () => null,
      environment,
      fetch: fetcher,
      log: (line) => lines.push(line),
    });
    await catalogue.read();
    for (const call of calls)
      expect(JSON.stringify(call.headers)).not.toContain(MANAGED);
    expect(calls.some((call) => call.url.includes("anthropic.com"))).toBe(
      false,
    );
    expect(lines).toContain(
      JSON.stringify({
        type: "model-list-unreadable",
        source: "claude",
        reason: "harness-token-elsewhere",
      }),
    );
  });

  test("a model nothing describes yet is still listed, on its own default effort", async () => {
    const listing = await fixture("openai-models.json");
    listing.data.push({
      id: "gpt-7-nova",
      object: "model",
      created: 1_800_000_000,
      owned_by: "system",
    });
    const { fetcher } = web({
      "https://api.openai.com/v1/models": listing,
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.models[0]).toEqual({
      id: "gpt-7-nova",
      label: "GPT-7 Nova",
      vendor: "openai",
    });
    // With no price it cannot be placed in the line, so the default stays where the data puts it.
    expect(read.default).toBe("gpt-6.1-terra");
    // Picked with an effort it does not declare, none is sent.
    expect(
      await catalogue.choose({ model: "gpt-7-nova", effort: "high" }),
    ).toEqual({ model: "gpt-7-nova", label: "GPT-7 Nova", listed: true });
  });

  test("without models.dev the provider's own data still applies, and the default is the configured model", async () => {
    const { fetcher } = web({
      "https://api.openai.com/v1/models": await fixture("openai-models.json"),
      [MODELS_DEV]: new Response("unavailable", { status: 503 }),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-6.1-terra" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      log: () => undefined,
    });
    const read = await catalogue.read();
    expect(read.default).toBe("gpt-6.1-terra");
    expect(read.choosable).toBe(true);
    expect(efforts(read, "gpt-6.1-terra")).toEqual({
      id: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      vendor: "openai",
    });
  });

  test("models.dev can be turned off, and is then never asked", async () => {
    const { fetcher, asked } = web({
      "https://api.x.ai/v1/language-models": await fixture(
        "xai-language-models.json",
      ),
    });
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "grok-4.7" },
      apiKey: async () => KEY,
      environment: {
        OPENAI_BASE_URL: "https://api.x.ai/v1",
        BOT_MODEL: "grok-4.7",
        OPENBOT_MODEL_CAPABILITIES_URL: "off",
      },
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(asked(MODELS_DEV)).toBe(0);
    // xAI's own listing still says how Grok thinks.
    expect(efforts(read, "grok-4.7")?.defaultEffort).toBe("high");
  });
});

describe("whose model is the default", () => {
  async function openAIWith(model: { defaultModel: string; pinned?: boolean }) {
    const { fetcher } = web({
      "https://api.openai.com/v1/models": await fixture("openai-models.json"),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    return createModelCatalogue({
      model: { provider: "openai", ...model },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
  }

  test("a model the operator named stays the default while the credential lists it", async () => {
    const read = await (
      await openAIWith({ defaultModel: "gpt-6-sol", pinned: true })
    ).read();
    expect(read.default).toBe("gpt-6-sol");
  });

  test("nobody named one: the middle of the current line", async () => {
    // The package's own model is a fallback, not a choice anybody made.
    const read = await (
      await openAIWith({ defaultModel: "gpt-5.6-terra" })
    ).read();
    expect(read.default).toBe("gpt-6.1-terra");
  });

  test("a named model the credential does not list gives way to the middle", async () => {
    const read = await (
      await openAIWith({ defaultModel: "gpt-9-imaginary", pinned: true })
    ).read();
    expect(read.default).toBe("gpt-6.1-terra");
  });

  test("a ChatGPT plan named gpt-5.5, which it does not offer, lands on the plan's middle", async () => {
    const { fetcher } = web({
      "http://agent-harness:4206/models": {
        object: "list",
        data: [
          { id: "gpt-6.1-terra", efforts: ["low", "medium", "high"] },
          { id: "gpt-6.1-sol", efforts: ["low", "medium", "high"] },
          { id: "gpt-6-luna", efforts: ["low", "medium"] },
        ],
      },
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    const catalogue = createModelCatalogue({
      model: {
        provider: "openai",
        defaultModel: "gpt-5.5",
        pinned: true,
        plan: {
          provider: "chatgpt",
          endpoint: new URL("http://agent-harness:4206/"),
          token: "managed-token",
        },
      },
      apiKey: async () => null,
      environment: {},
      fetch: fetcher,
    });
    expect((await catalogue.read()).default).toBe("gpt-6.1-terra");
  });
});

describe("a run's model and effort", () => {
  async function openAI() {
    const { fetcher } = web({
      "https://api.openai.com/v1/models": await fixture("openai-models.json"),
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    return createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
    });
  }

  test("nothing picked: the default, and no effort, so the model thinks on its own default", async () => {
    expect(await (await openAI()).choose(null)).toEqual({
      model: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      listed: true,
    });
  });

  test("a pick and an effort the model takes are used", async () => {
    expect(
      await (await openAI()).choose({ model: "gpt-6.1-sol", effort: "xhigh" }),
    ).toEqual({
      model: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      effort: "xhigh",
      listed: true,
    });
  });

  test("an effort the model does not take is never sent", async () => {
    // GPT-6.1 Sol takes no `none`, and GPT-4o takes no effort at all.
    expect(
      await (await openAI()).choose({ model: "gpt-6.1-sol", effort: "none" }),
    ).toEqual({ model: "gpt-6.1-sol", label: "GPT-6.1 Sol", listed: true });
    expect(
      await (await openAI()).choose({ model: "gpt-4o", effort: "high" }),
    ).toEqual({ model: "gpt-4o", label: "GPT-4o", listed: true });
  });

  /*
   * A routine runs with nobody watching, and models stop early more often at low and medium effort,
   * so with no effort picked it asks for high where the model takes it. The person's own pick still
   * wins, and a model that takes no effort is sent none.
   */
  test("a run nobody is watching thinks at high where the model takes it, unless the person picked", async () => {
    const catalogue = await openAI();
    expect(await catalogue.choose(null, "high")).toEqual({
      model: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      effort: "high",
      listed: true,
    });
    expect(
      await catalogue.choose({ model: "gpt-6.1-sol", effort: "low" }, "high"),
    ).toEqual({
      model: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      effort: "low",
      listed: true,
    });
    expect(await catalogue.choose({ model: "gpt-4o" }, "high")).toEqual({
      model: "gpt-4o",
      label: "GPT-4o",
      listed: true,
    });
  });

  test("a model no longer offered falls back to the default, with an effort only if the default takes it", async () => {
    expect(
      await (await openAI()).choose({ model: "gpt-4-0613", effort: "max" }),
    ).toEqual({
      model: "gpt-6.1-terra",
      label: "GPT-6.1 Terra",
      effort: "max",
      listed: true,
    });
  });
});

describe("keeping the list current without a release", () => {
  const LISTING = "https://api.openai.com/v1/models";

  async function provider() {
    const listing = await fixture("openai-models.json");
    const site = web({
      [LISTING]: listing,
      [MODELS_DEV]: await fixture("models-dev-api.json"),
    });
    let clock = 1_000_000_000_000;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: site.fetcher,
      now: () => clock,
      log: () => undefined,
    });
    return {
      site,
      listing,
      catalogue,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test("a run or a picker never asks the provider: one read at the start, then only the schedule", async () => {
    const { site, catalogue, advance } = await provider();
    await Promise.all([catalogue.read(), catalogue.read()]);
    for (let message = 0; message < 50; message += 1) {
      advance(60_000);
      await catalogue.choose({ model: "gpt-6.1-sol", effort: "high" });
      await catalogue.read();
    }
    // Fifty minutes of messages: still the one read.
    expect(site.asked(LISTING)).toBe(1);
    expect(site.asked(MODELS_DEV)).toBe(1);
  });

  test("a new model appears and a retired one disappears at the next refresh, and the default follows", async () => {
    const { site, listing, catalogue, advance } = await provider();
    const before = await catalogue.read();
    expect(before.models.map((model) => model.id)).toContain("gpt-6.1-terra");
    expect(before.default).toBe("gpt-6.1-terra");

    // OpenAI ships GPT-6.2 Terra and retires GPT-6.1 Terra.
    site.set(LISTING, {
      ...listing,
      data: [
        ...listing.data.filter(
          (model: { id: string }) => model.id !== "gpt-6.1-terra",
        ),
        {
          id: "gpt-6.2-terra",
          object: "model",
          created: 1_793_000_000,
          owned_by: "system",
        },
      ],
    });
    const models = await fixture("models-dev-api.json");
    models.openai.models["gpt-6.2-terra"] = {
      ...models.openai.models["gpt-6.1-terra"],
      id: "gpt-6.2-terra",
      name: "GPT-6.2 Terra",
      release_date: "2026-11-04",
    };
    site.set(MODELS_DEV, models);

    // Not before the schedule.
    advance(REFRESH_MS / 2);
    expect((await catalogue.read()).default).toBe("gpt-6.1-terra");
    // The schedule's refresh, through the same path the timer takes.
    advance(REFRESH_MS);
    await catalogue.refresh();

    const after = await catalogue.read();
    const ids = after.models.map((model) => model.id);
    expect(ids).toContain("gpt-6.2-terra");
    expect(ids).not.toContain("gpt-6.1-terra");
    expect(after.default).toBe("gpt-6.2-terra");
    expect(efforts(after, "gpt-6.2-terra")?.efforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // A conversation still on the retired model now runs on the default.
    expect(
      await catalogue.choose({ model: "gpt-6.1-terra", effort: "max" }),
    ).toEqual({
      model: "gpt-6.2-terra",
      label: "GPT-6.2 Terra",
      effort: "max",
      listed: true,
    });
  });

  test("a model past the shutdown date OpenAI lists drops out on its own", async () => {
    const { site, listing, catalogue } = await provider();
    site.set(LISTING, {
      ...listing,
      data: listing.data.map((model: { id: string }) =>
        model.id === "gpt-6-luna"
          ? { ...model, shutdown_date: "2000-01-01" }
          : model,
      ),
    });
    expect(
      (await catalogue.read()).models.map((model) => model.id),
    ).not.toContain("gpt-6-luna");
  });

  test("a refresh that fails keeps the last good list", async () => {
    const { site, catalogue, advance } = await provider();
    await catalogue.read();
    site.set(LISTING, new Response("down", { status: 503 }));
    advance(REFRESH_MS + 1);
    await catalogue.refresh();
    const read = await catalogue.read();
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("gpt-6.1-terra");
  });

  test("a provider refusing a model refreshes at once, at most once a minute", async () => {
    const { site, listing, catalogue, advance } = await provider();
    await catalogue.read();
    expect(site.asked(LISTING)).toBe(1);
    site.set(LISTING, {
      ...listing,
      data: listing.data.filter(
        (model: { id: string }) => model.id !== "gpt-6.1-sol",
      ),
    });

    expect(
      isModelUnavailableMessage(
        "Error code: 400 - {'detail': \"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.\"}",
      ),
    ).toBe(true);
    expect(
      isModelUnavailableMessage(
        "The model `gpt-6.1-sol` does not exist or you do not have access to it.",
      ),
    ).toBe(true);
    expect(isModelUnavailableMessage("Rate limit reached")).toBe(false);

    reportModelRejected();
    reportModelRejected();
    await catalogue.refresh();
    expect(site.asked(LISTING)).toBe(2);
    expect(
      (await catalogue.read()).models.map((model) => model.id),
    ).not.toContain("gpt-6.1-sol");

    advance(61_000);
    reportModelRejected();
    await catalogue.refresh();
    expect(site.asked(LISTING)).toBeGreaterThanOrEqual(3);
  });

  test("a stale list is refreshed in the background while it keeps answering", async () => {
    const { site, catalogue, advance } = await provider();
    await catalogue.read();
    advance(REFRESH_MS + 1);
    const read = await catalogue.read();
    // Answered at once from what it had.
    expect(read.default).toBe("gpt-6.1-terra");
    await catalogue.refresh();
    expect(site.asked(LISTING)).toBe(2);
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
      capabilitiesUrl: null,
    });

    expect(await catalogue.read()).toEqual({
      provider: "openai",
      source: "openai",
      exposure: "all",
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
      capabilitiesUrl: null,
    });
    await Promise.all([catalogue.read(), catalogue.read()]);
    await catalogue.read();
    expect(calls).toHaveLength(1);
  });

  test("asks again once what it read has gone stale, without making anybody wait", async () => {
    const { fetcher, calls } = provider(openAIListing(["gpt-5.5", "gpt-4o"]));
    let clock = 0;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
      now: () => clock,
      refreshMs: 1_000_000,
    });
    await catalogue.read();
    clock = 1_000_001;
    await catalogue.read();
    await catalogue.refresh();
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
      capabilitiesUrl: null,
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
      capabilitiesUrl: null,
    });
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "smart",
      "fast",
    ]);
    expect(calls[0]?.headers).toEqual({});
  });

  test("a configured model the provider no longer lists is never the default", async () => {
    // The ChatGPT plan's gpt-5.5 was this: configured, not offered, and every message failed.
    const { fetcher } = provider(openAIListing(["gpt-4o", "gpt-6-sol"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
    });
    const read = await catalogue.read();
    expect(read.models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-4o",
    ]);
    expect(read.default).toBe("gpt-6-sol");
  });

  test("a gateway's configured model is offered even when its listing leaves it out", async () => {
    // A gateway's operator named that model on purpose; its listing may be partial.
    const { fetcher } = provider(openAIListing(["fast"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "smart" },
      apiKey: async () => null,
      environment: { OPENAI_BASE_URL: "http://127.0.0.1:4011/v1" },
      fetch: fetcher,
      capabilitiesUrl: null,
    });
    const read = await catalogue.read();
    expect(read.models.map((model) => model.id)).toEqual(["smart", "fast"]);
    expect(read.default).toBe("smart");
  });

  test("a read while the first listing is still on its way waits for it, rather than answering empty", async () => {
    // A router's list and models.dev take seconds; the picker can open in that window after boot.
    let release: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url) === "https://models.dev/api.json")
        return new Response("unavailable", { status: 503 });
      await arrived;
      return Response.json(openAIListing(["fast", "smart"]));
    }) as typeof fetch;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "smart" },
      apiKey: async () => null,
      environment: { OPENAI_BASE_URL: "http://127.0.0.1:4011/v1" },
      fetch: fetcher,
      log: () => undefined,
    });
    const stop = catalogue.start();
    try {
      const reading = catalogue.read();
      release();
      const read = await reading;
      expect(read.choosable).toBe(true);
      expect(read.models.map((model) => model.id)).toEqual(["smart", "fast"]);
    } finally {
      stop();
    }
  });

  test("a gateway routing every vendor keeps the model its operator named, not one vendor's middle", async () => {
    // A router such as OpenRouter lists every vendor's models under their namespaced names, and
    // models.dev knows each one's line and price, so a middle could be computed across all of them.
    // Listed together, as a router does: one release date, so only the line and the price differ.
    const listing = {
      object: "list",
      data: [
        "openai/gpt-6-luna",
        "openai/gpt-6.1-terra",
        "openai/gpt-6.1-sol",
        "anthropic/claude-sonnet-5-5",
        "x-ai/grok-4.7",
      ].map((id) => ({ id, object: "model", created: 1_790_000_000 })),
    };
    const modelsDev = await Bun.file(
      `${import.meta.dir}/fixtures/model-listings/models-dev-api.json`,
    ).json();
    const fetcher = (async (url: string | URL | Request) =>
      Response.json(
        String(url) === "https://models.dev/api.json" ? modelsDev : listing,
      )) as typeof fetch;
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "x-ai/grok-4.7" },
      apiKey: async () => null,
      environment: { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" },
      fetch: fetcher,
    });
    const read = await catalogue.read();
    expect(read.source).toBe("gateway");
    expect(read.default).toBe("x-ai/grok-4.7");
    // Under the names the gateway gives them, every one alike, with its maker's mark.
    expect(
      read.models.find((model) => model.id === "x-ai/grok-4.7"),
    ).toMatchObject({ label: "x-ai/grok-4.7", vendor: "xai" });
    // Each still says how it thinks, read from models.dev by its vendor's name.
    expect(
      read.models.find((model) => model.id === "anthropic/claude-sonnet-5-5")
        ?.efforts,
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("a provider that cannot be read leaves only the deployment's model, and nothing to choose", async () => {
    const { fetcher } = provider({ error: "nope" }, 500);
    const logged: string[] = [];
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
      log: (line) => logged.push(line),
    });
    expect(await catalogue.read()).toEqual({
      provider: "openai",
      source: "openai",
      exposure: "all",
      default: "gpt-5.5",
      choosable: false,
      models: [{ id: "gpt-5.5", label: "GPT-5.5", vendor: "openai" }],
    });
    expect(logged.join("\n")).toContain("model-list-unreadable");
    // Never the key.
    expect(logged.join("\n")).not.toContain(KEY);
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
      capabilitiesUrl: null,
      allowlist: () => allowlist,
    });
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-4o",
    ]);
    // An admin taking every model away leaves the default, and nothing to pick.
    allowlist = { enabled: false, models: [] };
    const read = await catalogue.read();
    expect(read.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(read.choosable).toBe(false);
  });

  test("a team gets the default only until an admin allows a model, and then picks among those", async () => {
    const { fetcher } = provider(
      openAIListing(["gpt-4o", "gpt-5.5", "gpt-6-sol"]),
    );
    let allowed: string[] = [];
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
      // Whether "Only allowed models" is on is the gate's business; the picker reads the list.
      allowlist: () => ({ enabled: false, models: allowed }),
    });
    const before = await catalogue.read();
    expect(before.exposure).toBe("allowed");
    expect(before.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
    expect(before.choosable).toBe(false);

    allowed = ["openai/gpt-6-sol"];
    const after = await catalogue.read();
    expect(after.models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-5.5",
    ]);
    expect(after.choosable).toBe(true);
  });

  test("one person on their own machine is offered everything, and no allowlist narrows it", async () => {
    const { fetcher } = provider(
      openAIListing(["gpt-4o", "gpt-5.5", "gpt-6-sol"]),
    );
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
    });
    const read = await catalogue.read();
    expect(read.exposure).toBe("all");
    expect(read.models.map((model) => model.id)).toEqual([
      "gpt-6-sol",
      "gpt-5.5",
      "gpt-4o",
    ]);
    expect(read.choosable).toBe(true);
  });

  test("an allowed model the provider stops listing drops out, and a pick on it runs on the default", async () => {
    const listing = openAIListing(["gpt-4o", "gpt-5.5", "gpt-6-sol"]);
    const { fetcher } = provider(listing);
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
      allowlist: () => ({ enabled: true, models: ["openai/gpt-6-sol"] }),
    });
    expect(await catalogue.choose({ model: "gpt-6-sol" })).toEqual({
      model: "gpt-6-sol",
      label: "GPT-6 Sol",
      listed: true,
    });
    listing.data = listing.data.filter((model) => model.id !== "gpt-6-sol");
    await catalogue.refresh();
    expect((await catalogue.read()).models.map((model) => model.id)).toEqual([
      "gpt-5.5",
    ]);
    expect(await catalogue.choose({ model: "gpt-6-sol" })).toEqual({
      model: "gpt-5.5",
      label: "GPT-5.5",
      listed: true,
    });
  });

  test("allows only what it offers", async () => {
    const { fetcher } = provider(openAIListing(["gpt-4o", "gpt-5.5"]));
    const catalogue = createModelCatalogue({
      model: { provider: "openai", defaultModel: "gpt-5.5" },
      apiKey: async () => KEY,
      environment: {},
      fetch: fetcher,
      capabilitiesUrl: null,
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
      capabilitiesUrl: null,
      allowlist: () => ({ enabled: true, models: ["openai/gpt-5.5"] }),
    });
    expect(await catalogue.available()).toEqual({
      provider: "openai",
      source: "openai",
      exposure: "allowed",
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
      capabilitiesUrl: null,
      log: () => undefined,
    });
    expect(await catalogue.available()).toEqual({
      provider: "openai",
      source: "openai",
      exposure: "all",
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
    capabilitiesUrl: null,
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
