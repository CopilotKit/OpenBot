/**
 * How a failed run ends: one RUN_ERROR carrying the provider's own words, a code the server reads,
 * and `metadata.errorCategory`.
 *
 * The same codes and sentences as agent-langgraph-agui (`tool_runtime.py`), so the server's refusal
 * reading (`provider-refusal.ts`) and `refusal_kind` treat this engine as it treats that one. The
 * category is the one agent-claude-sdk sends, in Claude Code's spelling (`AssistantMessageError`),
 * which is what `BY_CATEGORY` on the server reads: `authentication_failed`, not `authentication`.
 *
 * LangChain JS throws each vendor SDK's own error, not the AI SDK's `APICallError`: the OpenAI and
 * Anthropic SDKs' `APIError` (`status`, `error` = the body, `message` = "400 ..."), and
 * `@langchain/google`'s `RequestError` / `AuthError` (`statusCode`, `message` = Google's words).
 * Each is read here by what it carries rather than by class, so a wrapped one reads the same.
 */

export const MODEL_REFUSED = "OPENBOT_MODEL_REFUSED";
export const MODEL_AUTH_REQUIRED = "OPENBOT_MODEL_AUTH_REQUIRED";
export const MODEL_BILLING = "OPENBOT_MODEL_BILLING";
export const MODEL_UNREACHABLE = "OPENBOT_MODEL_UNREACHABLE";

/** What a person reads when a run fails for a reason that is not the provider's. */
export const RUN_FAILED =
  "The Bot stopped before it finished answering. Try again.";

export type ErrorCategory =
  | "rate_limit"
  | "billing_error"
  | "server_error"
  | "invalid_request"
  | "authentication_failed"
  | "model_not_found"
  | "outdated_client"
  | "refusal"
  | "unknown";

export type RunFailure = {
  message: string;
  code?: string;
  category?: ErrorCategory;
};

/**
 * The model declined to answer: Anthropic's `stop_reason: "refusal"`, OpenAI's `refusal` content,
 * Gemini's safety stop. The one real refusal, sent as category "refusal" so the server says so.
 */
export class ModelDeclinedError extends Error {
  constructor(words: string) {
    super(words || "The model declined to answer this request.");
    this.name = "ModelDeclinedError";
  }
}

/**
 * A RUN_ERROR from the ChatGPT plan's harness, relayed as that harness said it: its words, its code
 * and its category are already the contract's.
 */
export class HarnessRunError extends Error {
  readonly code?: string;
  readonly category?: string;
  constructor(message: string, code?: string, category?: string) {
    super(message);
    this.name = "HarnessRunError";
    this.code = code;
    this.category = category;
  }
}

/**
 * What the providers say when the money has run out, in any of their spellings. The same pattern as
 * agent-langgraph-agui's `BILLING` and the server's `model-billing.ts`.
 */
export const BILLING =
  /(no credits remaining|credit[_ ]balance|insufficient[_ ]quota|used all available credits|spending limit|exceeded your current quota|usage limits?|purchase (more )?credits)/i;

/** Claude's "version 2.1.290 or newer is required": only a newer client fixes it. */
const OUTDATED =
  /does not support this model;? version [\d.]+ or newer is required|\bor newer is required\b/i;

/**
 * A key the provider would not take, in the words of providers that answer it with a 400: Gemini's
 * "API key not valid. Please pass a valid API key." (INVALID_ARGUMENT, reason API_KEY_INVALID).
 */
const KEY =
  /api key not valid|api_key_invalid|incorrect api key|invalid x-api-key|invalid api key/i;

/** The codes a connection that never opened is given, by Node, undici and the SDKs. */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

type Link = Record<string, unknown> & { message?: unknown; name?: unknown };

/** The error and every error it was raised from. */
export function links(error: unknown): Link[] {
  const seen = new Set<unknown>();
  const out: Link[] = [];
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    out.push(current as Link);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The HTTP status a provider answered with, as each SDK keeps it. */
export function statusOf(link: Link): number | undefined {
  for (const value of [
    link.status,
    link.statusCode,
    asRecord(link.response)?.status,
  ]) {
    if (typeof value === "number" && value >= 400 && value <= 599) return value;
  }
  return undefined;
}

/** The provider's error body, as each SDK keeps it. */
function bodyOf(link: Link): Record<string, unknown> | string | undefined {
  // OpenAI's SDK keeps only the body's `error` field; Anthropic's keeps the whole body.
  if (typeof link.error === "string") return link.error;
  return (
    asRecord(link.error) ?? asRecord(link.body) ?? asRecord(link.responseBody)
  );
}

/** The provider's own message, without the SDK's status prefix. */
export function providerWords(link: Link): string {
  const body = bodyOf(link);
  if (typeof body === "string") {
    if (body.trim()) return body.trim();
  } else if (body) {
    const nested = body.error;
    for (const value of [
      asRecord(nested)?.message,
      typeof nested === "string" ? nested : undefined,
      body.message,
      body.detail,
    ]) {
      const found = text(value);
      if (found) return found;
    }
  }
  const message = text(link.message) ?? "";
  return (
    message.replace(/^\d{3}\s+(?:status code \(no body\))?/, "").trim() ||
    message
  );
}

/** The provider's machine-readable kind of error, where its body has one. */
function providerKind(link: Link): string {
  const body = bodyOf(link);
  const record = typeof body === "object" ? body : undefined;
  const nested = asRecord(record?.error);
  return [
    record?.type,
    record?.code,
    record?.status,
    nested?.type,
    nested?.code,
    nested?.status,
    link.type,
    link.code,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/** Which category a provider's refusal is, by its status, its kind and its words. */
export function categoryFor(
  status: number | undefined,
  kind: string,
  words: string,
): ErrorCategory {
  if (
    BILLING.test(words) ||
    /insufficient_quota|billing_error|credit/.test(kind)
  )
    return "billing_error";
  if (OUTDATED.test(words)) return "outdated_client";
  if (status === 402) return "billing_error";
  if (
    status === 401 ||
    /authentication_error|unauthenticated|invalid_api_key|api_key_invalid/.test(
      kind,
    ) ||
    KEY.test(words)
  )
    return "authentication_failed";
  if (status === 403 || /permission_error|permission_denied/.test(kind))
    return "authentication_failed";
  if (status === 429 || /rate_limit|resource_exhausted/.test(kind))
    return "rate_limit";
  if (
    /model_not_found/.test(kind) ||
    (status === 404 && /\bmodel\b/i.test(words))
  )
    return "model_not_found";
  if (
    (status !== undefined && status >= 500) ||
    /overloaded|api_error|unavailable|internal/.test(kind)
  )
    return "server_error";
  if (status !== undefined && status >= 400) return "invalid_request";
  return "unknown";
}

/** Whether nothing answered at the model's address: the request never reached a provider. */
export function unreached(error: unknown): boolean {
  return links(error).some((link) => {
    // The OpenAI and Anthropic SDKs' classes keep the name "Error"; their constructors say which.
    const kind = `${String(link.name)} ${(link as { constructor?: { name?: string } }).constructor?.name ?? ""}`;
    return (
      /\bAPIConnection(?:Timeout)?Error\b/.test(kind) ||
      (typeof link.code === "string" && NOT_CONNECTED.has(link.code))
    );
  });
}

/**
 * Where the model was dialled, as host and port only: a base URL can carry a user and password,
 * and some gateways put a key in the path. Nothing for OpenBot's own sign-in proxy, whose address
 * is OpenBot's and not the model's.
 */
export function shownAddress(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.pathname.includes("/api/model-provider/")) return undefined;
    return url.host || undefined;
  } catch {
    return undefined;
  }
}

export function unreachableMessage(address: string | undefined): string {
  const at = address ? ` at ${address}` : "";
  return `OpenBot couldn't reach the AI model${at}. Check that it's running and the address is right.`;
}

export type FailureContext = {
  /** Who serves the model, by the name a person knows it by. See `providerName`. */
  provider: string;
  /** Where the model is dialled, for the unreachable sentence. */
  baseUrl?: string;
};

/**
 * The RUN_ERROR a failed run ends with. Never throws: every run ends with a terminal event, and the
 * error itself goes to the log.
 */
export function runFailure(
  error: unknown,
  context: FailureContext,
): RunFailure {
  const chain = links(error);

  for (const link of chain) {
    if (link instanceof HarnessRunError) {
      const category =
        typeof link.category === "string"
          ? (link.category as ErrorCategory)
          : undefined;
      return {
        message: link.message,
        ...(link.code ? { code: link.code } : {}),
        ...(category ? { category } : {}),
      };
    }
    if (link instanceof ModelDeclinedError) {
      return {
        message: link.message,
        code: MODEL_REFUSED,
        category: "refusal",
      };
    }
  }

  for (const link of chain) {
    const status = statusOf(link);
    if (status === undefined) continue;
    const words = providerWords(link);
    const category = categoryFor(
      status,
      providerKind(link),
      `${words} ${String(link.message ?? "")}`,
    );
    if (category === "billing_error") {
      const name = context.provider;
      const who = name === "Your model provider" ? "your model provider" : name;
      return {
        message:
          `${name} didn't answer: the account is out of credit or has reached its spending limit. ` +
          `Add credit or raise the limit with ${who}, then try again. ${name} said: "${words}"`,
        code: MODEL_BILLING,
        category,
      };
    }
    // The status in the spelling the server reads first (`STATUS` in provider-refusal.ts), and
    // agent-langgraph-agui's: "Error code: 400 - <the provider's words>".
    return {
      message: `Error code: ${status} - ${words}`,
      code:
        category === "authentication_failed"
          ? MODEL_AUTH_REQUIRED
          : MODEL_REFUSED,
      category,
    };
  }

  if (unreached(error)) {
    return {
      message: unreachableMessage(shownAddress(context.baseUrl)),
      code: MODEL_UNREACHABLE,
    };
  }

  return { message: RUN_FAILED };
}
