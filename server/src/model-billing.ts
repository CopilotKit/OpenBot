/**
 * A model provider refusing because the account is out of credit or at its spending limit, told as
 * that, with which provider and in the provider's own words.
 *
 * Without this a person read "Forbidden" (xAI answers 403 with a body the AI SDK cannot parse) or
 * "Failed after 3 attempts" (OpenAI answers 429, which is retried as if it were a rate limit), and a
 * framework Bot told them to sign in again, which fixes nothing. The refusals this recognises are
 * the providers' own, as they answer them:
 *
 * - OpenAI, 429: `{"error":{"message":"You have no credits remaining. …","type":"insufficient_quota","code":"credit_balance_exhausted"}}`
 * - xAI, 403: `{"code":"permission-denied","error":"Your team … has either used all available credits or reached its monthly spending limit. …"}`
 * - Anthropic, 400: `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. …"}}`
 * - Google, 429: `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. …","status":"RESOURCE_EXHAUSTED"}}`
 *
 * No imports, for the reason `model-rejection.ts` has none.
 */

/** What the providers say when the money has run out, in any of their spellings. */
export const BILLING =
  /(no credits remaining|credit[_ ]balance|insufficient[_ ]quota|used all available credits|spending limit|exceeded your current quota|usage limits?|purchase (more )?credits)/i;

/** Who a person is told refused, by the model list's source. */
export function providerName(source: string | undefined): string {
  switch (source) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "xai":
      return "xAI";
    case "chatgpt":
      return "ChatGPT";
    case "claude":
      return "Claude";
    default:
      return "Your model provider";
  }
}

/** The provider's own message from a response body, in the shapes the providers use. */
export function bodyMessage(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed.error;
    const candidates = [
      nested && typeof nested === "object"
        ? (nested as Record<string, unknown>).message
        : nested,
      parsed.message,
      parsed.detail,
    ];
    const found = candidates.find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );
    return found?.trim();
  } catch {
    return body.trim().slice(0, 500);
  }
}

/** Every error this one carries: a retry's attempts, a cause, a wrapped error. */
export function chain(error: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && found.length < 16) {
    const next = queue.shift();
    if (!next || typeof next !== "object" || found.includes(next as never))
      continue;
    const record = next as Record<string, unknown>;
    found.push(record);
    queue.push(record.lastError, record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }
  return found;
}

/** The person-facing sentence: what happened, with whom, the next step, then the provider's words. */
export function billingMessage(provider: string, said: string): string {
  const who =
    provider === "Your model provider" ? "your model provider" : provider;
  return `${provider} didn't answer: the account is out of credit or has reached its spending limit. Add credit or raise the limit with ${who}, then try again. ${provider} said: "${said}"`;
}

/**
 * The refusal as a person should read it, when this error is a provider saying the account is out
 * of credit or at its limit. Undefined for anything else, which keeps its own message.
 */
export function billingRefusal(
  error: unknown,
  provider: string,
): Error | undefined {
  // The provider's own response first: a retry's summary repeats it with "Failed after 3 attempts".
  const links = chain(error).sort(
    (a, b) => Number(!!b.responseBody) - Number(!!a.responseBody),
  );
  for (const link of links) {
    const said =
      bodyMessage(link.responseBody) ??
      (typeof link.message === "string" ? link.message : undefined);
    const text = [said, link.responseBody, link.message]
      .filter((value) => typeof value === "string")
      .join(" ");
    if (!said || !BILLING.test(text)) continue;
    const refusal = new Error(billingMessage(provider, said));
    refusal.name = "ModelBillingError";
    return refusal;
  }
  return undefined;
}
