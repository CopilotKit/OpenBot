/**
 * A handed-back tool call signed for Gemini, for the TypeScript engines. The rules are those of
 * `shared/gemini_signatures.py`, which every Python engine uses.
 *
 * Gemini 3 and later refuse a function call in the current turn that does not carry the thought
 * signature the model gave it: "Function call is missing a thought_signature in functionCall
 * parts". OpenBot runs each tool between two runs, and an AG-UI tool call has no field for a
 * signature, so a call can come back without its own. Google documents a value for a history whose
 * signatures are not available, `skip_thought_signature_validator`.
 *
 * `signingFetch` wraps the `fetch` a model client is given, and rewrites a request body only when
 * it is a Gemini request:
 *  - Gemini's own API: a POST to `.../models/gemini-...:generateContent` or
 *    `:streamGenerateContent`, whatever the host. Each `functionCall` part with no
 *    `thoughtSignature` is given the placeholder.
 *  - Google's OpenAI-compatible endpoint (`generativelanguage.googleapis.com/.../openai/`), or
 *    OpenBot's model gateway asked for a Gemini model: each assistant `tool_calls` entry with no
 *    `extra_content.google.thought_signature` is given the placeholder there.
 * A signature already there is kept, and every other request is sent exactly as it was built.
 */

/** Google's documented stand-in for a signature that is not available. */
export const GEMINI_UNSIGNED_CALL = "skip_thought_signature_validator";

const GOOGLE_HOST = "generativelanguage.googleapis.com";
const GATEWAY_PATH = "/api/model-provider/";
const NATIVE_PATH = /\/models\/([^/:]+):(?:stream)?[gG]enerateContent$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a model name names a Gemini model; a gateway's `google/gemini-...` counts. */
export function isGeminiModel(model: unknown): boolean {
  return (
    typeof model === "string" &&
    (model.trim().toLowerCase().split("/").at(-1) ?? "").startsWith("gemini-")
  );
}

/** Every unsigned `functionCall` part in a generateContent body, signed. Whether any was. */
export function signContents(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.contents)) return false;
  let signed = false;
  for (const content of body.contents) {
    if (!isObject(content) || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (
        !isObject(part) ||
        !("functionCall" in part || "function_call" in part)
      )
        continue;
      if (part.thoughtSignature || part.thought_signature) continue;
      part.thoughtSignature = GEMINI_UNSIGNED_CALL;
      signed = true;
    }
  }
  return signed;
}

/** Every unsigned assistant tool call in a Chat Completions body, signed. Whether any was. */
export function signMessages(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.messages)) return false;
  let signed = false;
  for (const message of body.messages) {
    if (!isObject(message) || message.role !== "assistant") continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (!isObject(call)) continue;
      const extra = isObject(call.extra_content) ? call.extra_content : {};
      const google = isObject(extra.google) ? extra.google : {};
      if (google.thought_signature) continue;
      call.extra_content = {
        ...extra,
        google: { ...google, thought_signature: GEMINI_UNSIGNED_CALL },
      };
      signed = true;
    }
  }
  return signed;
}

/** The request body with its Gemini tool calls signed, or undefined to send it as it was. */
export function signedBody(
  method: string,
  url: string,
  body: string | undefined,
): string | undefined {
  if (!body || method.toUpperCase() !== "POST") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const native = NATIVE_PATH.exec(parsed.pathname);
  const chat = parsed.pathname.endsWith("/chat/completions");
  if (native ? !isGeminiModel(native[1]) : !chat) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!native) {
    if (!isObject(json) || !isGeminiModel(json.model)) return undefined;
    if (
      parsed.hostname.toLowerCase() !== GOOGLE_HOST &&
      !parsed.pathname.includes(GATEWAY_PATH)
    )
      return undefined;
  }
  const changed = native ? signContents(json) : signMessages(json);
  return changed ? JSON.stringify(json) : undefined;
}

/** `inner`, with every Gemini request's tool calls signed on the way out. */
export function signingFetch(inner: typeof fetch = fetch): typeof fetch {
  const signed = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (input instanceof Request) {
      if (init?.body === undefined && input.body) {
        const body = signedBody(
          input.method,
          input.url,
          await input.clone().text(),
        );
        if (body !== undefined)
          return inner(new Request(input, { ...init, body }));
      }
      return inner(input, init);
    }
    const body =
      typeof init?.body === "string"
        ? signedBody(init.method ?? "GET", String(input), init.body)
        : undefined;
    if (body === undefined) return inner(input, init);
    const headers = new Headers(init?.headers);
    headers.delete("content-length");
    return inner(input, { ...init, headers, body });
  };
  return signed as typeof fetch;
}
