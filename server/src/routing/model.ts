import type { RuntimeModel } from "../copilot";

/**
 * The one model call the router makes, kept apart from the routing logic so that logic stays a pure
 * function the tests drive without a network. This reuses the deployment's own model and key — the
 * same ones the built-in coworkers answer on — so a router is never a second thing to configure.
 *
 * It throws on a missing key or a bad response on purpose: the router treats a throw as "not sure"
 * and lands on the default, so failure here is a soft landing, not an error a person sees.
 */
export function createModelCompleter(deps: {
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
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
}): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt: string, signal?: AbortSignal) => {
    const fast =
      typeof deps.fastModel === "function" ? deps.fastModel() : deps.fastModel;
    const models =
      fast && fast !== deps.model.defaultModel
        ? [fast, deps.model.defaultModel]
        : [deps.model.defaultModel];
    signal?.throwIfAborted();
    const key = await deps.resolveApiKey();
    signal?.throwIfAborted();
    if (!key) throw new Error("no model key");
    const anthropic = deps.model.provider === "anthropic";
    let response: Response | undefined;
    for (const model of models) {
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

    function ask(model: string, key: string): Promise<Response> {
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
              ? { max_tokens: 1024 }
              : { response_format: { type: "json_object" } }),
            messages: [{ role: "user", content: prompt }],
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
      );
    }
  };
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
