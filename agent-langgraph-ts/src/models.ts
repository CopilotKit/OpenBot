/**
 * The model a run thinks with, chosen the way agent-langgraph-agui chooses it (`_model` in main.py).
 *
 * THE SERVER CHOOSES FIRST. A run carrying `forwardedProps.openbotModel` answers on that model at
 * that effort, on whichever credential the deployment has. A run without one answers on the
 * deployment's configuration: `BOT_PROVIDER` and `BOT_MODEL`, then shared/model-providers.json.
 *
 * WHICH CREDENTIAL, BY SIGN-IN:
 *  - An API key (Anthropic, OpenAI, Google, any OpenAI-compatible endpoint): the provider directly.
 *  - A Gemini sign-in: `BOT_PROVIDER=openai`, `OPENAI_BASE_URL` = the server's provider OAuth proxy
 *    (`/api/model-provider/v1`) and `OPENAI_API_KEY` = its local bearer. Ordinary Chat Completions,
 *    which the server turns into Google's API with the person's token, exactly as for the Python
 *    harness. Nothing here knows it is Google.
 *  - A ChatGPT plan: `CHATGPT_PLAN_HARNESS_URL` names agent-langgraph-agui, which holds the Codex
 *    transport, and every model call goes there (`plan-model.ts`). Selected by its presence.
 *
 * THE LIVE AI CONNECTION, PER RUN. Where the deployment names its model gateway
 * (`OPENBOT_MODEL_GATEWAY_URL`), the server says how each run's model is reached
 * (`forwardedProps.openbotModelRoute`), and that is all that decides it: `openai` or `anthropic`
 * through the gateway with the run's own token (the gateway adds the connection's key), or
 * `chatgpt-plan` / `claude-plan` to that plan's engine. This engine holds no provider key, so the
 * person changing the connection changes the next run, with nothing restarted. See `routedModel`.
 */
import { readFileSync } from "node:fs";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogle } from "@langchain/google";
import { ChatOpenAI } from "@langchain/openai";
// The one rule every Bot in the box decides by, imported rather than copied, so a model OpenAI
// moves to the Responses API moves here in the same change. Node loads it through the JSON hook in
// json-modules.ts (see there for why and how).
import { requiresResponsesApi } from "../../shared/model-providers.ts";
import { withContextEditing } from "./context-room.ts";
import { HarnessRunError, MODEL_UNREACHABLE } from "./errors.ts";
import { PlanHarnessChatModel } from "./plan-model.ts";

export type Env = Record<string, string | undefined>;

/** This engine's row in shared/model-providers.json, when it has one. */
export const BOT_ID = "agent-langgraph-ts";

/** The reasoning efforts the server sends, in its own spelling. Anything else is not an effort. */
export const RUN_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
/** `outputConfig.effort` in @langchain/anthropic. */
export const ANTHROPIC_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
/** `reasoningEffort` in @langchain/google. */
export const GOOGLE_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

export type RunModel = {
  /** The model the server chose for this run, or "" for the deployment's own. */
  model: string;
  /** The effort the server chose, or "" for the model's own default. */
  effort: string;
  /** The server retries this run itself (`openbotSendOnce`): ask once and hand a failure back. */
  sendOnce: boolean;
  /** The Bot the run is for, sent on to a plan's harness. */
  botId?: string;
  /** How the server said this run's model is reached, when it said. */
  route?: ModelRoute;
  /** The run's thread, which a Claude plan's query is kept under. */
  threadId?: string;
  /** The run's organization, when the server names one, which joins that query's name. */
  organization?: string;
  /** The run's own stop, which cancels a Claude plan's query. */
  signal?: AbortSignal;
};

export const ROUTES = new Set([
  "openai",
  "anthropic",
  "chatgpt-plan",
  "claude-plan",
] as const);
export type ModelRoute = {
  via: "openai" | "anthropic" | "chatgpt-plan" | "claude-plan";
  /** The run's gateway token, for `openai` and `anthropic`. */
  token?: string;
};

/** `forwardedProps.openbotModelRoute`, as the server sends it. Anything else is no route. */
export function runRoute(
  props: Record<string, unknown>,
): ModelRoute | undefined {
  const route = props.openbotModelRoute;
  if (!route || typeof route !== "object") return undefined;
  const { via, token } = route as { via?: unknown; token?: unknown };
  if (typeof via !== "string" || !ROUTES.has(via as ModelRoute["via"]))
    return undefined;
  return {
    via: via as ModelRoute["via"],
    ...(typeof token === "string" && token.trim()
      ? { token: token.trim() }
      : {}),
  };
}

/** The `(model, effort)` the server chose for this run, from `forwardedProps.openbotModel`. */
export function runModel(props: Record<string, unknown>): {
  model: string;
  effort: string;
} {
  const choice = props.openbotModel;
  if (!choice || typeof choice !== "object") return { model: "", effort: "" };
  const { model, reasoningEffort } = choice as {
    model?: unknown;
    reasoningEffort?: unknown;
  };
  if (typeof model !== "string" || !model.trim())
    return { model: "", effort: "" };
  const effort =
    typeof reasoningEffort === "string" && RUN_EFFORTS.has(reasoningEffort)
      ? reasoningEffort
      : "";
  return { model: model.trim(), effort };
}

type Spec = {
  providers: Record<string, { default_model: string }>;
  bots: Record<string, { provider: string; model: string }>;
};

function specPath(env: Env): URL | string {
  const override = env.BOT_SPEC_PATH?.trim();
  // Beside this engine in the repository, and at /shared in the image (src is /app/src).
  return (
    override || new URL("../../shared/model-providers.json", import.meta.url)
  );
}

let cachedSpec: { path: string; spec: Spec } | undefined;
function spec(env: Env): Spec {
  const path = String(specPath(env));
  if (cachedSpec?.path !== path) {
    cachedSpec = {
      path,
      spec: JSON.parse(readFileSync(specPath(env), "utf8")) as Spec,
    };
  }
  return cachedSpec.spec;
}

/** The provider spellings this engine serves, with LangChain's own as aliases. */
const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  google_genai: "google",
  gemini: "google",
};

/**
 * This Bot's provider and model, environment over spec file over provider default: the lookup of
 * `bot_settings` in shared/model_providers.py. A blank value is not a choice.
 */
export function botSettings(env: Env): { provider: string; model: string } {
  const file = spec(env);
  const row = file.bots[BOT_ID];
  const named = env.BOT_PROVIDER?.trim().toLowerCase();
  const provider =
    (named && (PROVIDER_ALIASES[named] ?? named)) || row?.provider || "openai";
  const model =
    env.BOT_MODEL?.trim() ||
    (row && row.provider === provider ? row.model : undefined) ||
    file.providers[provider]?.default_model ||
    file.providers.openai?.default_model ||
    "";
  return { provider, model };
}

/** Who serves this engine's model, by the name a person knows it by (`provider_name` in Python). */
export function providerName(env: Env): string {
  if (env.CHATGPT_PLAN_HARNESS_URL?.trim()) return "ChatGPT";
  const provider =
    PROVIDER_ALIASES[(env.BOT_PROVIDER ?? "openai").trim().toLowerCase()] ??
    "openai";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  const base = env.OPENAI_BASE_URL?.trim();
  if (!base) return "OpenAI";
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    return "Your model provider";
  }
  if (host === "api.openai.com") return "OpenAI";
  if (host === "api.x.ai") return "xAI";
  if (host === "generativelanguage.googleapis.com") return "Google";
  if (base.includes("/api/model-provider/")) {
    const model = (env.BOT_MODEL ?? "").trim().toLowerCase();
    if (model.startsWith("grok")) return "xAI";
    if (model.startsWith("gemini")) return "Google";
  }
  return "Your model provider";
}

/** Where this engine dials its model, for the unreachable sentence. */
export function modelBaseUrl(env: Env): string | undefined {
  if (env.CHATGPT_PLAN_HARNESS_URL?.trim())
    return env.CHATGPT_PLAN_HARNESS_URL.trim();
  const provider = botSettings(env).provider;
  if (provider === "anthropic")
    return env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  if (provider === "google")
    return (
      env.GOOGLE_GENERATIVE_AI_BASE_URL?.trim() ||
      "https://generativelanguage.googleapis.com"
    );
  return env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
}

/**
 * The client's own retries: two, as the Python integrations default to, and none for a run the
 * server retries itself, where one rate limit asked again several times over without the wait is
 * worse than handing it back. LangChain JS would otherwise retry six times.
 */
function retries(run: RunModel): number {
  return run.sendOnce ? 0 : 2;
}

/** Chat Completions only, whatever LangChain prefers for the model name. */
class ChatOpenAICompletionsOnly extends ChatOpenAI {
  override _useResponsesApi(): boolean {
    return false;
  }
}

function openAIModel(model: string, run: RunModel, env: Env): BaseChatModel {
  const baseURL = env.OPENAI_BASE_URL?.trim() || undefined;
  // An endpoint that needs no key still needs a string for the SDK (Ollama, vLLM, LM Studio).
  const apiKey =
    env.OPENAI_API_KEY?.trim() || (baseURL ? "no-key-needed" : undefined);
  const chatOnly = env.COPILOTKIT_OPENAI_API?.trim() === "chat";
  const fields = {
    model,
    apiKey,
    maxRetries: retries(run),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  };
  // THE MODEL DECIDES, NOT THE ADDRESS: a gateway in front of OpenAI cannot say which API a model
  // takes. An operator who set COPILOTKIT_OPENAI_API=chat has decided.
  if (requiresResponsesApi(model) && !chatOnly) {
    return new ChatOpenAI({
      ...fields,
      useResponsesApi: true,
      ...(run.effort ? { reasoning: { effort: run.effort as never } } : {}),
    });
  }
  // `reasoning_effort` as it is, for any model, as agent-langgraph-agui sends it: LangChain's own
  // `reasoning` is dropped for a model it does not know as OpenAI's (Gemini or Grok behind a
  // compatible endpoint, the Gemini sign-in's proxy), and those endpoints read the field too.
  return new ChatOpenAICompletionsOnly({
    ...fields,
    ...(run.effort ? { modelKwargs: { reasoning_effort: run.effort } } : {}),
  });
}

function anthropicModel(model: string, run: RunModel, env: Env): BaseChatModel {
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim() || undefined;
  // Anthropic clears old tool results on its side, so a long run stays inside the window
  // (context-room.ts), unless a proxy at this address has already refused it.
  return withContextEditing(
    new ChatAnthropic({
      model,
      apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
      maxRetries: retries(run),
      ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
      ...(ANTHROPIC_EFFORTS.has(run.effort)
        ? { outputConfig: { effort: run.effort as never } }
        : {}),
    }),
  );
}

/** `GOOGLE_GENERATIVE_AI_BASE_URL` may end in its API version, as the AI SDK takes it. */
function googleEndpoint(env: Env): { endpoint?: string; apiVersion?: string } {
  const raw = env.GOOGLE_GENERATIVE_AI_BASE_URL?.trim();
  if (!raw) return {};
  const match = /^(.*?)\/(v\d+(?:alpha|beta)?\d*)\/?$/.exec(raw);
  return match
    ? { endpoint: match[1], apiVersion: match[2] }
    : { endpoint: raw.replace(/\/$/, "") };
}

function googleModel(model: string, run: RunModel, env: Env): BaseChatModel {
  return new ChatGoogle({
    model,
    apiKey:
      env.GOOGLE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || undefined,
    platformType: "gai",
    maxRetries: retries(run),
    ...googleEndpoint(env),
    ...(GOOGLE_EFFORTS.has(run.effort)
      ? { reasoningEffort: run.effort as never }
      : {}),
  });
}

const MAKERS: Record<
  string,
  (model: string, run: RunModel, env: Env) => BaseChatModel
> = {
  openai: openAIModel,
  anthropic: anthropicModel,
  google: googleModel,
};

/** The chat model for this run. */
export function chatModel(
  run: RunModel,
  env: Env = process.env,
): BaseChatModel {
  const routed = routedModel(run, env);
  if (routed) return routed;
  const planUrl = env.CHATGPT_PLAN_HARNESS_URL?.trim();
  if (planUrl) {
    const token =
      env.CHATGPT_PLAN_HARNESS_TOKEN?.trim() ||
      env.MANAGED_AGENT_TOKEN?.trim() ||
      "";
    return new PlanHarnessChatModel({
      url: planUrl,
      token,
      model: run.model,
      effort: run.effort,
      botId: run.botId,
    });
  }
  const settings = botSettings(env);
  const model = run.model || settings.model;
  // A recognised `provider:model` keeps its provider. Otherwise the model is an opaque id (an
  // Ollama `qwen2.5:1.5b` has a colon too) and the configured provider serves it.
  const separator = model.indexOf(":");
  const prefix =
    separator > 0 ? PROVIDER_ALIASES[model.slice(0, separator)] : undefined;
  const prefixed = prefix ? MAKERS[prefix] : undefined;
  if (prefixed) return prefixed(model.slice(separator + 1), run, env);
  const make = MAKERS[settings.provider];
  if (!make)
    throw new Error(
      `This Bot cannot run on the provider "${settings.provider}".`,
    );
  return make(model, run, env);
}

/** The model gateway's root (`OPENBOT_MODEL_GATEWAY_URL`), or undefined where there is none. */
export function gatewayUrl(env: Env): string | undefined {
  return env.OPENBOT_MODEL_GATEWAY_URL?.trim().replace(/\/+$/, "") || undefined;
}

/** A `provider:model` name, as the server may send it, is the model it names. */
function bareModel(model: string): string {
  const separator = model.indexOf(":");
  return separator > 0 && PROVIDER_ALIASES[model.slice(0, separator)]
    ? model.slice(separator + 1)
    : model;
}

/**
 * The model the server's route names for this run, or undefined where there is no route (or no
 * gateway, as on a deployment from before the live connection), which is today's environment.
 *
 *  - `openai`: ChatOpenAI at `${gateway}/v1` with the run token as its key; Responses or Chat
 *    Completions by the model, as for a key.
 *  - `anthropic`: ChatAnthropic at `${gateway}/anthropic` with the run token as its key.
 *  - `chatgpt-plan`: the ChatGPT plan's engine, as `CHATGPT_PLAN_HARNESS_URL` reaches it today.
 *  - `claude-plan`: the Claude engine's `/model` (`CLAUDE_PLAN_HARNESS_URL`), the deployment's
 *    token, one Claude query per Bot and thread, cancelled when the run is stopped.
 */
function routedModel(run: RunModel, env: Env): BaseChatModel | undefined {
  const gateway = gatewayUrl(env);
  const route = run.route;
  if (!gateway || !route) return undefined;
  if (route.via === "chatgpt-plan" || route.via === "claude-plan") {
    const claude = route.via === "claude-plan";
    const url = (
      claude ? env.CLAUDE_PLAN_HARNESS_URL : env.CHATGPT_PLAN_HARNESS_URL
    )?.trim();
    if (!url)
      throw new HarnessRunError(
        `OpenBot can't reach ${claude ? "Claude" : "ChatGPT"} on the plan: its engine isn't set up here.`,
        MODEL_UNREACHABLE,
      );
    const token =
      (claude ? undefined : env.CHATGPT_PLAN_HARNESS_TOKEN?.trim()) ||
      env.MANAGED_AGENT_TOKEN?.trim() ||
      "";
    return new PlanHarnessChatModel({
      plan: claude ? "claude" : "chatgpt",
      url: claude ? `${url.replace(/\/+$/, "")}/model` : url,
      token,
      model: run.model,
      effort: run.effort,
      botId: run.botId,
      ...(claude
        ? {
            threadId: run.threadId ?? "",
            ...(run.organization ? { organization: run.organization } : {}),
            signal: run.signal,
          }
        : {}),
    });
  }
  if (!route.token)
    throw new HarnessRunError(
      "This run came without its pass for OpenBot's model gateway. Try again.",
    );
  const model =
    bareModel(run.model) || spec(env).providers[route.via]?.default_model || "";
  if (route.via === "anthropic")
    return anthropicModel(model, run, {
      ...env,
      ANTHROPIC_BASE_URL: `${gateway}/anthropic`,
      ANTHROPIC_API_KEY: route.token,
    });
  return openAIModel(model, run, {
    ...env,
    OPENAI_BASE_URL: `${gateway}/v1`,
    OPENAI_API_KEY: route.token,
  });
}
