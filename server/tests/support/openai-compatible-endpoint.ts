import { readFileSync } from "node:fs";

/**
 * An OpenAI-compatible endpoint that answers the way OpenAI itself does, for both APIs a built-in Bot can call:
 * Chat Completions (`/chat/completions`) and the Responses API (`/responses`).
 *
 * What it answers is OpenAI's, not made up here. The two streams in `fixtures/openai-wire/` are OpenAI's own bytes,
 * one streamed answer from each API with a function tool offered (`gpt-5.6-terra` on `/v1/responses`, `gpt-5.5` on
 * `/v1/chat/completions`, recorded 2026-10-28). The refusals below are OpenAI's own bodies, word for word, from the
 * same day: every model of OpenAI's catalogue asked for a tool on both APIs.
 *
 * It stands for a gateway or a proxy in front of OpenAI (LiteLLM, Portkey, a company's own proxy): it sits at an
 * address that is not OpenAI's, so the CopilotKit runtime treats it as any OpenAI-compatible server, and it applies
 * OpenAI's rules to the model after the last slash, because a gateway that publishes `openai/gpt-5.6-terra` hands
 * OpenAI `gpt-5.6-terra`. With `responsesApi: false` it is a server that only speaks Chat Completions, which answers
 * the Responses API's path as OpenAI answers a path it does not serve: 404, no body.
 */

/** `gpt-5.6-*` and `gpt-6*`: 400 on `/v1/chat/completions` with function tools, unless reasoning is turned off. */
const REFUSES_TOOLS_ON_CHAT = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
]);

/** Of those, the ones that cannot have reasoning turned off either. */
const REASONING_ALWAYS_ON = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

const NOT_A_CHAT_MODEL =
  "This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?";

/** Models `/v1/chat/completions` does not serve at all (404), with what OpenAI says about each. */
const NOT_ON_CHAT: Record<string, string> = {
  "gpt-5-pro":
    "This model is only supported in v1/responses and not in v1/chat/completions.",
  "gpt-5.2-pro": NOT_A_CHAT_MODEL,
  "gpt-5.4-pro": NOT_A_CHAT_MODEL,
  "gpt-5.5-pro": NOT_A_CHAT_MODEL,
  "o3-pro": NOT_A_CHAT_MODEL,
  "gpt-5.3-codex":
    "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.",
};

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/openai-wire/${name}`, import.meta.url));

/** What a Bot asked this endpoint for. */
export type EndpointRequest = {
  api: "chat" | "responses";
  /** The model as the Bot named it, namespace and all. */
  model: string;
  /** The names of the function tools that came with it. */
  tools: string[];
};

export type OpenAICompatibleEndpoint = {
  /** What `OPENAI_BASE_URL` is set to, `/v1` included, as `.env.example` documents it. */
  baseUrl: string;
  requests: EndpointRequest[];
  stop(): Promise<void>;
};

function openAIError(
  status: number,
  message: string,
  param: string,
  code: string | null = null,
) {
  return Response.json(
    { error: { message, type: "invalid_request_error", param, code } },
    { status },
  );
}

function stream(name: string) {
  return new Response(fixture(name), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

export function startOpenAICompatibleEndpoint(
  options: { responsesApi?: boolean } = {},
): OpenAICompatibleEndpoint {
  const responsesApi = options.responsesApi ?? true;
  const requests: EndpointRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const api =
        request.method === "POST" && path === "/v1/chat/completions"
          ? "chat"
          : request.method === "POST" &&
              path === "/v1/responses" &&
              responsesApi
            ? "responses"
            : undefined;
      if (!api) return new Response(null, { status: 404 });
      const body = (await request.json()) as {
        model?: unknown;
        tools?: unknown;
        reasoning_effort?: unknown;
      };
      const model = typeof body.model === "string" ? body.model : "";
      // Chat Completions nests a tool's name under `function`; the Responses API does not.
      const tools = (Array.isArray(body.tools) ? body.tools : []).map(
        (tool: { name?: unknown; function?: { name?: unknown } }) =>
          String(tool.function?.name ?? tool.name),
      );
      requests.push({ api, model, tools });
      if (api === "responses") return stream("responses-stream.sse");
      const name = model.split("/").at(-1) ?? "";
      const notServed = NOT_ON_CHAT[name];
      if (notServed) return openAIError(404, notServed, "model");
      if (body.reasoning_effort === "none" && REASONING_ALWAYS_ON.has(name))
        return openAIError(
          400,
          "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
          "reasoning_effort",
          "unsupported_value",
        );
      if (
        REFUSES_TOOLS_ON_CHAT.has(name) &&
        tools.length > 0 &&
        body.reasoning_effort !== "none"
      )
        return openAIError(
          400,
          `Function tools with reasoning_effort are not supported for ${name} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
          "reasoning_effort",
        );
      return stream("chat-stream.sse");
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
