/**
 * THE CONVERSATION'S MODEL PICKER, FOR EVERY WAY THE DESKTOP SIGNS IN.
 *
 * The picker shows when the catalogue says `choosable`: more than one model a run may use. Each test
 * here starts from the environment OpenBot Desktop writes for one row of its model screen
 * (`desktop/src-tauri/src/env.rs`), turns it into the deployment's model the way the server does at
 * boot (`runtimeModelForEnvironment`, `planModelForEnvironment`), and reads the catalogue against
 * providers that answer as the real ones do: their captured listings for the right credential, and
 * a 401 for anything else. A Google or xAI sign-in goes through OpenBot's real sign-in proxy.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { runtimeModelForEnvironment } from "../src/copilot";
import {
  clearDesktopConnectionFailure,
  mountDesktopConnectionFailure,
} from "../src/desktop-connection-failure";
import { createModelCatalogue } from "../src/model-catalogue";
import {
  createProviderOAuthProxy,
  type ModelOAuthRecord,
  mountProviderOAuthProxy,
} from "../src/provider-oauth";

const LISTINGS = `${import.meta.dir}/fixtures/model-listings/`;
const listing = (name: string) => Bun.file(LISTINGS + name).json();
const MODELS_DEV = "https://models.dev/api.json";

/** The tenant package every desktop ships (`examples/fintech/model.yaml`). */
const PACKAGE_MODEL = {
  provider: "openai" as const,
  defaultModel: "gpt-5.6-terra",
};

const OPENAI_KEY = "openai-key-for-this-test";
const ANTHROPIC_KEY = "anthropic-key-for-this-test";
const GEMINI_KEY = "gemini-key-for-this-test";
const XAI_KEY = "xai-key-for-this-test";
const CLAUDE_OAUTH = "claude-plan-oauth-token-for-this-test";
const MANAGED = "managed-agent-token-for-the-harness-only";
const PROXY_TOKEN = "local-proxy-token-for-this-test";
const ACCESS = "provider-access-token-for-this-test";
const SERVER = "http://127.0.0.1:43110";
const HARNESS = "http://127.0.0.1:43206";

/** Every key the Desktop owns, emptied the way it empties them before writing one row's. */
const CLEARED = {
  OPENAI_API_KEY: "",
  OPENAI_BASE_URL: "",
  OPENAI_CONTAINER_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  CHATGPT_AUTH_FILE: "",
  OPENBOT_MODEL_OAUTH_FILE: "",
  BOT_PROVIDER: "",
  CHATGPT_OAUTH_TOKEN: "",
};

const unauthorised = (message: string) =>
  Response.json(
    { type: "error", error: { type: "authentication_error", message } },
    { status: 401 },
  );

type Behaviour = {
  /** Whether Anthropic lists models for a Claude plan's OAuth token. Undocumented either way. */
  anthropicListsForPlan: boolean;
  /** Whether xAI lists models for the Grok sign-in's token. Undocumented either way. */
  xaiListsForSignIn: boolean;
};

/**
 * The providers, as they answer each credential. What a provider would answer a request with no
 * route here is 404, which the catalogue treats like any other unreadable listing.
 */
async function providers(behaviour: Behaviour) {
  const [openai, anthropic, geminiNative, geminiOpenAI, xai, modelsDev] =
    await Promise.all([
      listing("openai-models.json"),
      listing("anthropic-models.json"),
      listing("gemini-native-models.json"),
      listing("gemini-openai-models.json"),
      listing("xai-language-models.json"),
      listing("models-dev-api.json"),
    ]);
  const asked: { url: string; headers: Headers }[] = [];
  const answer = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    asked.push({ url, headers });
    const bearer = headers.get("authorization");
    if (url === MODELS_DEV) return Response.json(modelsDev);
    if (url === "https://api.openai.com/v1/models")
      return bearer === `Bearer ${OPENAI_KEY}`
        ? Response.json(openai)
        : Response.json(
            { error: { message: "Incorrect API key provided" } },
            { status: 401 },
          );
    if (url.startsWith("https://api.anthropic.com/v1/models")) {
      if (headers.get("x-api-key") === ANTHROPIC_KEY)
        return Response.json(anthropic);
      if (
        bearer === `Bearer ${CLAUDE_OAUTH}` &&
        headers.get("anthropic-beta")?.includes("oauth-2025-04-20")
      )
        return behaviour.anthropicListsForPlan
          ? Response.json(anthropic)
          : unauthorised("OAuth authentication is currently not supported.");
      return unauthorised("invalid x-api-key");
    }
    if (url === `${HARNESS}/models`)
      return headers.get("x-openbot-agent-token") === MANAGED
        ? Response.json({
            object: "list",
            data: [
              { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
              { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
              { id: "gpt-6-luna", label: "GPT-6 Luna" },
            ],
          })
        : Response.json({ error: "unauthorised" }, { status: 401 });
    if (
      url ===
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
    )
      return bearer === `Bearer ${ACCESS}` &&
        headers.get("x-goog-user-project") === "quota-project"
        ? Response.json(geminiNative)
        : Response.json({ error: { code: 401 } }, { status: 401 });
    if (
      url === "https://generativelanguage.googleapis.com/v1beta/openai/models"
    )
      return bearer === `Bearer ${GEMINI_KEY}`
        ? Response.json(geminiOpenAI)
        : Response.json({ error: { code: 401 } }, { status: 401 });
    if (url === "https://api.x.ai/v1/language-models") {
      if (bearer === `Bearer ${XAI_KEY}`) return Response.json(xai);
      if (bearer === `Bearer ${ACCESS}` && behaviour.xaiListsForSignIn)
        return Response.json(xai);
      return Response.json({ error: "Incorrect API key" }, { status: 401 });
    }
    // Both sign-ins' token endpoints: a refresh succeeds and hands back the same token.
    if (
      url === "https://auth.x.ai/oauth2/token" ||
      url === "https://oauth2.googleapis.com/token"
    )
      return Response.json(
        { access_token: ACCESS, token_type: "Bearer", expires_in: 3600 },
        { status: 200 },
      );
    if (url === "http://127.0.0.1:11434/v1/models")
      return Response.json({
        object: "list",
        data: [
          { id: "llama3.3:70b", object: "model", created: 1_760_000_000 },
          { id: "qwen3:32b", object: "model", created: 1_770_000_000 },
          { id: "nomic-embed-text", object: "model", created: 1_750_000_000 },
        ],
      });
    return new Response("not found", { status: 404 });
  };
  return { answer, asked };
}

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => clearDesktopConnectionFailure("model"));
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  clearDesktopConnectionFailure("model");
});

/** OpenBot's sign-in proxy, as the server mounts it, over a signed-in record on disk. */
async function signInProxy(
  provider: "google" | "xai",
  upstream: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  const root = await mkdtemp(join(tmpdir(), "openbot-picker-sign-in-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "model-oauth.json");
  const record: ModelOAuthRecord = {
    version: 1,
    sessionId: "session",
    provider,
    clientId: "desktop-client",
    accessToken: ACCESS,
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    scope: "scope",
    ...(provider === "google" ? { quotaProject: "quota-project" } : {}),
    proxyToken: PROXY_TOKEN,
  };
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  const app = new Hono();
  mountProviderOAuthProxy(
    app,
    createProviderOAuthProxy(file, { fetch: upstream }),
  );
  mountDesktopConnectionFailure(app, "host-token");
  return { app, file };
}

/**
 * The catalogue a deployment boots with from one Desktop environment: the model the server resolves
 * from it, the key it resolves, and the web as `providers` answers it. Requests to this server's own
 * sign-in proxy go to the proxy.
 */
async function catalogueFor(
  written: Record<string, string>,
  behaviour: Behaviour = {
    anthropicListsForPlan: false,
    xaiListsForSignIn: false,
  },
  signIn?: "google" | "xai",
) {
  const environment = { ...CLEARED, ...written };
  const web = await providers(behaviour);
  const proxy = signIn ? await signInProxy(signIn, web.answer) : undefined;
  const model = runtimeModelForEnvironment(PACKAGE_MODEL, environment);
  const lines: string[] = [];
  const catalogue = createModelCatalogue({
    model,
    apiKey: async () =>
      (model.provider === "anthropic"
        ? environment.ANTHROPIC_API_KEY
        : environment.OPENAI_API_KEY) || null,
    environment,
    log: (line) => lines.push(line),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (proxy && url.startsWith(SERVER))
        return proxy.app.request(new URL(url).pathname, init);
      return web.answer(input, init);
    }) as typeof fetch,
  });
  const read = await catalogue.read();
  const failure = proxy
    ? await (
        await proxy.app.request("/api/desktop/connection-failure", {
          headers: { "x-openbot-desktop-host-token": "host-token" },
        })
      ).json()
    : null;
  return { catalogue, read, asked: web.asked, lines, failure };
}

const ids = (read: { models: { id: string }[] }) =>
  read.models.map((model) => model.id);

/** Never sent to anything but the plan's own harness. */
function neverSentAway(asked: { url: string; headers: Headers }[]) {
  for (const call of asked)
    if (!call.url.startsWith(HARNESS))
      for (const [, value] of call.headers)
        expect(value).not.toContain(MANAGED);
}

const claudePlan = {
  CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH,
  PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot-agent-claude-sdk:1.0.0",
  PICKED_HARNESS_URL: HARNESS,
  MANAGED_AGENT_TOKEN: MANAGED,
};

describe("every sign-in the Desktop offers has a model to pick", () => {
  test("an OpenAI API key: OpenAI's own listing, on its current middle", async () => {
    const { read } = await catalogueFor({ OPENAI_API_KEY: OPENAI_KEY });
    expect(read.source).toBe("openai");
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("gpt-6.1-terra");
  });

  test("a ChatGPT plan: what the plan's harness lists", async () => {
    const { read, asked } = await catalogueFor({
      CHATGPT_AUTH_FILE: "/run/openbot/chatgpt-auth.json",
      PICKED_HARNESS_IMAGE:
        "ghcr.io/copilotkit/openbot-agent-langgraph-agui:1.0.0",
      PICKED_HARNESS_URL: HARNESS,
      MANAGED_AGENT_TOKEN: MANAGED,
    });
    expect(read.source).toBe("chatgpt");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toEqual(["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna"]);
    neverSentAway(asked);
  });

  test("an Anthropic API key: Anthropic's own listing, on Sonnet", async () => {
    const { read } = await catalogueFor({
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      BOT_PROVIDER: "anthropic",
    });
    expect(read.source).toBe("anthropic");
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("claude-sonnet-5-5");
  });

  test("a Claude plan Anthropic lists models for: Anthropic's listing, on the plan's token", async () => {
    const { read, asked } = await catalogueFor(claudePlan, {
      anthropicListsForPlan: true,
      xaiListsForSignIn: false,
    });
    expect(read.source).toBe("claude");
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("claude-sonnet-5-5");
    expect(ids(read)).toContain("claude-fable-5-1");
    neverSentAway(asked);
  });

  /*
   * THE BUG TEAMMATES SAW. Nothing documents Anthropic listing models for a Claude plan's token, and
   * when it refuses, the catalogue had nothing but the configured model (`gpt-5.6-terra`, the
   * package's, since a plan writes no provider), and the picker never showed. Now the models every
   * plan includes stand in, and a run is sent the one picked.
   */
  test("a Claude plan Anthropic will not list models for: the models every plan includes", async () => {
    const { read, asked, lines, catalogue } = await catalogueFor(claudePlan);
    expect(read.source).toBe("claude");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    expect(ids(read)).not.toContain("gpt-5.6-terra");
    // The same default Anthropic's own listing gives: the middle of the current line.
    expect(read.default).toBe("claude-sonnet-5-5");
    expect(read.models.find((model) => model.id === "claude-opus-5-5")).toEqual(
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        vendor: "anthropic",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    );
    // Asked of Anthropic with the plan's token, and refused; never with the harness's.
    expect(
      asked.some((call) => call.url.startsWith("https://api.anthropic.com/")),
    ).toBe(true);
    neverSentAway(asked);
    expect(lines).toContain(
      JSON.stringify({ type: "model-list-fallback", source: "claude" }),
    );
    // The harness is sent the pick, so the plan runs on it.
    expect(
      await catalogue.choose({ model: "claude-opus-5-5", effort: "high" }),
    ).toEqual({
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      effort: "high",
      listed: true,
    });
  });

  test("a Google sign-in: Google's own listing, through OpenBot's sign-in proxy", async () => {
    const { read, failure } = await catalogueFor(
      {
        OPENBOT_MODEL_OAUTH_FILE: "/ignored/by/this/test",
        OPENAI_API_KEY: PROXY_TOKEN,
        OPENAI_BASE_URL: `${SERVER}/api/model-provider/v1`,
        BOT_PROVIDER: "openai",
        BOT_MODEL: "gemini-3.8-flash",
      },
      undefined,
      "google",
    );
    expect(read.source).toBe("google");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toContain("gemini-3.8-flash");
    expect(failure).toBeNull();
  });

  test("an xAI sign-in xAI lists models for: xAI's own listing, through the proxy", async () => {
    const { read } = await catalogueFor(
      {
        OPENAI_API_KEY: PROXY_TOKEN,
        OPENAI_BASE_URL: `${SERVER}/api/model-provider/v1`,
        BOT_PROVIDER: "openai",
        BOT_MODEL: "grok-4.7",
      },
      { anthropicListsForPlan: false, xaiListsForSignIn: true },
      "xai",
    );
    expect(read.source).toBe("xai");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toContain("grok-4.5");
    expect(read.default).toBe("grok-4.7");
  });

  /*
   * Nothing documents xAI listing models for the Grok sign-in's token. Refused, the catalogue had the
   * one model the Desktop wrote and no picker, and the proxy told the Desktop the sign-in had lapsed,
   * which asked the person to sign in again over a sign-in that chats perfectly well.
   */
  test("an xAI sign-in xAI will not list models for: the sign-in's own models, and no false sign-in failure", async () => {
    const { read, failure } = await catalogueFor(
      {
        OPENAI_API_KEY: PROXY_TOKEN,
        OPENAI_BASE_URL: `${SERVER}/api/model-provider/v1`,
        BOT_PROVIDER: "openai",
        BOT_MODEL: "grok-4.7",
      },
      undefined,
      "xai",
    );
    expect(read.source).toBe("xai");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toEqual(["grok-4.7", "grok-4.3"]);
    // The model the Desktop set up stays the default.
    expect(read.default).toBe("grok-4.7");
    expect(failure).toBeNull();
  });

  test("a Gemini API key on Google's OpenAI-compatible endpoint", async () => {
    const { read } = await catalogueFor({
      OPENAI_API_KEY: GEMINI_KEY,
      OPENAI_BASE_URL:
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      BOT_MODEL: "gemini-3.8-flash",
    });
    expect(read.source).toBe("google");
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("gemini-3.8-flash");
  });

  test("an xAI API key on xAI's endpoint", async () => {
    const { read } = await catalogueFor({
      OPENAI_API_KEY: XAI_KEY,
      OPENAI_BASE_URL: "https://api.x.ai/v1",
      BOT_MODEL: "grok-4.7",
    });
    expect(read.source).toBe("xai");
    expect(read.choosable).toBe(true);
    expect(read.default).toBe("grok-4.7");
  });

  test("an OpenAI-compatible endpoint with no key: whatever it serves that can chat", async () => {
    const { read } = await catalogueFor({
      OPENAI_API_KEY: "not-needed",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      BOT_MODEL: "qwen3:32b",
    });
    expect(read.source).toBe("gateway");
    expect(read.choosable).toBe(true);
    expect(ids(read)).toEqual(["qwen3:32b", "llama3.3:70b"]);
    expect(read.default).toBe("qwen3:32b");
  });
});
