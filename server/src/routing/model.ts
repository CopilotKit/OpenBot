import { PlanModel, type PlanModelConfig } from "../agents/plan-model";
import type { RuntimeModel } from "../copilot";

/**
 * One model call on the deployment's own model, for the router, the approval reviewer and the tool
 * chooser, kept apart from their logic so that logic stays a pure function the tests drive without a
 * network. This reuses the model the built-in Bots answer on, with its key, or on a Claude or ChatGPT
 * plan its plan (`model.plan`), so none of them is a second thing to configure.
 *
 * It throws on a missing key, a bad response or a timeout on purpose: the router treats a throw as
 * "not sure" and lands on the default, the reviewer as "ask the person", and the chooser as "offer
 * what fits". A failure here is a soft landing, not an error a person sees.
 *
 * ON A PLAN THERE IS NO KEY, so the call is asked of the plan's own harness, the way the built-in
 * Bots and a conversation's title are. Asked for a key there, every call threw "no model key": the
 * chooser offered every tool, the router sent every message to the default Bot, and Auto-review
 * asked the person about everything it was meant to let through.
 */
/**
 * There is no key to call the model with, and no plan to call it through.
 *
 * Its own class so a caller that has to say so to a person (an admin describing a boundary in
 * English) can tell "nobody set a model up" from "the model did not answer", which call for different
 * next steps. The message is the one the other callers have always logged.
 */
export class ModelNotConfiguredError extends Error {
  constructor() {
    super("no model key");
    this.name = "ModelNotConfiguredError";
  }
}

/** The JSON Schema a call's answer must match, by name, for a provider that can hold it to one. */
export type ModelAnswerSchema = {
  name: string;
  schema: Record<string, unknown>;
};

export type ModelCallOptions = {
  /**
   * Asks the provider for structured output: `response_format` `json_schema` (strict) on Chat
   * Completions, `output_config.format` on Anthropic's Messages. Without it the call asks for a JSON
   * object on Chat Completions and nothing on Anthropic, which is what every older caller relies on.
   *
   * A model or gateway that refuses the schema answers 400; the call is then made once more without
   * it, and the prompt's own description of the object has to carry the shape. On a plan there is no
   * request body to put it in, so the prompt carries it there too.
   */
  schema?: ModelAnswerSchema;
};

export type ModelCompleter = (
  prompt: string,
  signal?: AbortSignal,
  options?: ModelCallOptions,
) => Promise<string>;

export function createModelCompleter(deps: {
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
  /**
   * How long one call may take. Ten seconds unless a caller says otherwise: the router and the
   * reviewer sit in front of a person mid-conversation and land softly on a timeout. A caller that
   * writes something longer for an admin who asked for it, a boundary rule, gives itself more.
   */
  timeoutMs?: number;
  /** Anthropic's output cap. 1024 covers a router's or reviewer's one object. */
  maxTokens?: number;
  /**
   * A smaller model to ask first, for a call that sits in front of a person waiting. See
   * `routingModelFor`. When it answers with an HTTP error (a key without access to it, a name the
   * endpoint does not know), the call is made again on `model`, so a wrong guess costs one round
   * trip and never the answer. A timeout or an abort is not retried: that is the same wait again.
   *
   * Asked on every call when a function, so a setting that changes which model may run (the admin's
   * model allowlist) applies to the next call and not the next restart.
   */
  fastModel?: string | (() => string | undefined);
}): ModelCompleter {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return async (prompt, signal, options) => {
    if (deps.model.plan) return askPlan(deps.model.plan, prompt, signal);
    const fast =
      typeof deps.fastModel === "function" ? deps.fastModel() : deps.fastModel;
    const models =
      fast && fast !== deps.model.defaultModel
        ? [fast, deps.model.defaultModel]
        : [deps.model.defaultModel];
    signal?.throwIfAborted();
    const key = await deps.resolveApiKey();
    signal?.throwIfAborted();
    if (!key) throw new ModelNotConfiguredError();
    const anthropic = deps.model.provider === "anthropic";
    let response: Response | undefined;
    for (const model of models) {
      response = await ask(model, key, options?.schema);
      // A model or gateway that cannot hold the answer to a schema says so with a 400. Asked once
      // more without it, the prompt still describes the object, so the answer is still checked.
      if (response.status === 400 && options?.schema)
        response = await ask(model, key);
      if (response.ok) break;
    }
    if (!response?.ok)
      throw new Error(`router model answered ${response?.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: unknown }[];
    };
    const content = anthropic
      ? body.content
          ?.filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text)
          .join("") || undefined
      : body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("router model returned no text");
    return content;

    function ask(
      model: string,
      key: string,
      schema?: ModelAnswerSchema,
    ): Promise<Response> {
      return fetch(
        anthropic
          ? anthropicMessagesUrl(process.env)
          : chatCompletionsUrl(process.env),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(anthropic
              ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
              : { authorization: `Bearer ${key}` }),
          },
          body: JSON.stringify({
            model,
            /*
             * No temperature.
             *
             * It was zero, for a router that answers the same way twice. Reasoning models refuse the
             * setting outright — "Unsupported value: 'temperature' does not support 0 with this model.
             * Only the default (1) value is supported" — and this call treats a throw as "not sure", so
             * every routing decision quietly became the default coworker and the roster was never
             * consulted. A question naming Google Drive went to a Bot holding no Drive tools, which is
             * the exact failure the roster exists to prevent, and nothing said so.
             *
             * Omitted rather than set per model, because a list of which models accept it is a list that
             * goes stale. `response_format` and a prompt that asks for one object keep the answer tight,
             * and the confidence floor still sends an unsure match to the default.
             */
            ...(anthropic
              ? {
                  max_tokens: deps.maxTokens ?? 1024,
                  ...(schema
                    ? {
                        output_config: {
                          format: {
                            type: "json_schema",
                            schema: schema.schema,
                          },
                        },
                      }
                    : {}),
                }
              : {
                  response_format: schema
                    ? {
                        type: "json_schema",
                        json_schema: {
                          name: schema.name,
                          schema: schema.schema,
                          strict: true,
                        },
                      }
                    : { type: "json_object" },
                }),
            messages: [{ role: "user", content: prompt }],
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        },
      );
    }
  };
}

/**
 * Pass one of tool selection: which skills a message needs, on the model the built-in Bots run on.
 *
 * ON A CLAUDE OR CHATGPT PLAN THERE IS NO KEY, so it is asked of the plan's own harness, as the Bots
 * are answered. Asked for a key there, it threw on every turn: Activity said "Couldn't choose, so all
 * were offered" for each message, and a Bot with ninety tools was handed all of them every time.
 */
export function createSkillChooser(
  model: RuntimeModel,
  resolveApiKey: () => Promise<string | null>,
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  const complete = createModelCompleter({ model, resolveApiKey });
  /*
   * Why it could not choose, in the log, once for each reason. The run carries on with every tool
   * that fits (see `fitToolLimit`) and its Activity row says it could not choose, but not why, and
   * a reason that holds for every turn is worth one line rather than one per turn.
   */
  const said = new Set<string>();
  return async (prompt, signal) => {
    try {
      return await complete(prompt, signal);
    } catch (error) {
      if (!signal?.aborted) {
        const reason = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, " ")
          .slice(0, 300);
        if (!said.has(reason)) {
          said.add(reason);
          console.warn(
            JSON.stringify({
              type: "tool-selection-unavailable",
              reason,
              ...(model.plan ? { plan: model.plan.provider } : {}),
            }),
          );
        }
      }
      throw error;
    }
  };
}

/**
 * How long one call to a plan's harness may take. Longer than a key's ten seconds, since a plan's
 * harness starts a query of its own for each call; the same bound a voice summary on a plan has.
 */
const PLAN_CALL_TIMEOUT_MS = 20_000;

/**
 * One answer from the plan's own harness: model only, no tools, and a conversation of its own each
 * time, so the call is never a turn in somebody's thread. Throws on no text, as the key path does.
 */
async function askPlan(
  plan: PlanModelConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // Aborted by hand: `AbortSignal.timeout` makes HttpAgent's cleanup rethrow a TimeoutError that
  // nothing catches. The same reason `channels/titler.ts` gives.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLAN_CALL_TIMEOUT_MS);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const result = await new PlanModel(
      plan,
      "openbot-model-call",
      { threadId: crypto.randomUUID() },
      new Set(),
      controller.signal,
    ).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      abortSignal: controller.signal,
    });
    const answer = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    if (!answer.trim()) throw new Error("plan model returned no text");
    return answer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}

/** The small model each provider's router asks first when nothing names one. */
const FAST_ROUTING_MODELS: Record<RuntimeModel["provider"], string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-6-luna",
};

/**
 * Which model picks a Bot for an untagged message, ahead of the deployment's own.
 *
 * The router runs while a person stares at the composer after pressing send, and it used to run on
 * the model the Bots answer on. On a reasoning model that one call was seconds of the wait, to pick
 * one name from a short list, which a small model does as well. `ROUTER_MODEL` names it outright.
 *
 * Nothing is guessed behind a gateway: `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` may serve any set of
 * names, so there the router keeps the deployment's model unless `ROUTER_MODEL` says otherwise.
 */
export function routingModelFor(
  model: RuntimeModel,
  environment: Record<string, string | undefined>,
): string | undefined {
  const configured = environment.ROUTER_MODEL?.trim();
  if (configured) return configured;
  const gateway =
    model.provider === "anthropic"
      ? environment.ANTHROPIC_BASE_URL
      : environment.OPENAI_BASE_URL;
  if (gateway?.trim()) return undefined;
  return FAST_ROUTING_MODELS[model.provider];
}

/**
 * Where this deployment's `/chat/completions` actually is.
 *
 * `/v1` USED TO BE APPENDED UNCONDITIONALLY, and that was wrong for every deployment that set the
 * variable. `.env.example` and `docs/configuration.md` both document it with the version in it
 * (`https://gateway.internal/v1`), because that is the shape the AI SDK wants: it takes `baseURL`
 * verbatim and asks for `/chat/completions` under it, which is how the built-in Bots reach the same
 * endpoint. Appending here produced `/v1/v1/chat/completions`, so on a gateway — the entire reason
 * the variable exists — every call from this function 404'd.
 *
 * That failure was invisible, which is the worst part. The router treats a throw as "not sure" and
 * lands on the default coworker, so a deployment behind a gateway silently stopped routing and
 * nothing anywhere said why. Tool selection reads through the same function and would have failed
 * the same way, offering the whole catalogue on the deployments most likely to have a big one.
 *
 * So the version segment is added only when the configured URL does not already end in one, and the
 * unset case keeps the public API's own `https://api.openai.com/v1`.
 */
export function chatCompletionsUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com")
    // A trailing slash is the difference between `/v1` and `/v1/`, and no more than that.
    .replace(/\/+$/, "");
  return /\/v\d+$/.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

/** Native Anthropic endpoint, accepting the same versioned base URL as the runtime. */
export function anthropicMessagesUrl(
  environment: Record<string, string | undefined>,
): string {
  const base = (
    environment.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}
