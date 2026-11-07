/**
 * A model provider refusing a run, said in words a person can act on.
 *
 * Seen on OpenBot Desktop: a Bot on the LangGraph harness ended its turn in red with "Error code: 400
 * - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with
 * length 202 instead." That is the OpenAI SDK's text for the provider's answer, passed through as the
 * RUN_ERROR both surfaces draw. Every harness has its own spelling of the same refusals: the Python
 * SDKs write "Error code: 400 - …", OpenAI's JS SDK "400 …", Claude Code "API Error: 500 …", and the
 * AI SDK under a built-in Bot throws an `APICallError` that carries the status.
 *
 * Here every one of them becomes a sentence naming the provider, what went wrong and the one thing to
 * do, and the provider's own text goes to the server log as `model-provider-refused`, where somebody
 * diagnosing it reads it. Anything that is not a provider's refusal passes through untouched: a Bot's
 * own error, an unreachable Bot, a stall, a stop.
 *
 * On the run rather than in each harness, so the Python harnesses keep sending the provider's words
 * (the server reads them to notice a retired model, see `model-rejection.ts`), and a harness somebody
 * else runs is told the same way as ours.
 */
import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  BILLING,
  billingMessage,
  billingRefusal,
  bodyMessage,
  chain,
} from "../model-billing";
import { currentEdition } from "../edition";
import { isModelUnavailableMessage } from "../model-rejection";

/** What went wrong, as far as a person needs to know. */
export type RefusalKind =
  | "key"
  | "billing"
  | "rate_limit"
  | "model"
  | "too_many_tools"
  | "too_long"
  | "too_large"
  | "provider_down"
  | "other";

export type Refusal = {
  kind: RefusalKind;
  /** The HTTP status the provider answered with, when the text or the error carries one. */
  status?: number;
  /** The provider's own message, for the log and for the billing sentence. */
  said: string;
};

/** Who refused, as the person knows them, and whether they signed in rather than pasted a key. */
export type RefusingProvider = {
  /** "OpenAI", "Anthropic", … or "Your model provider" when it can't be told. See `providerName`. */
  provider: string;
  signIn: boolean;
};

/** A harness saying the provider refused, in the provider's words. See agent-claude-sdk/src/adapter.py. */
export const MODEL_REFUSED = "OPENBOT_MODEL_REFUSED";
/** A harness saying the provider refused the credential. Both Python harnesses send it. */
export const MODEL_AUTH_REQUIRED = "OPENBOT_MODEL_AUTH_REQUIRED";
/** A harness saying the account is out of credit, already in words. See agent-langgraph-agui. */
const MODEL_BILLING = "OPENBOT_MODEL_BILLING";

/** The status a harness's text carries, in each SDK's spelling. */
const STATUS = [
  // OpenAI's and Anthropic's Python SDKs: "Error code: 400 - Invalid 'tools': array too long. …"
  /\bError code: (\d{3})\b/,
  // OpenAI's JS SDK, "400 Invalid 'tools': …", and Google's Python SDK, "429 RESOURCE_EXHAUSTED. …"
  /^(\d{3}) \S/,
  // Claude Code: "API Error: 500 Internal server error. …", "API Error: Request rejected (429) · …"
  /\bAPI Error: (?:Request rejected \()?(\d{3})\b/,
  // Claude Code, after its own retries: "API Error: Repeated 529 Overloaded errors. …"
  /\bAPI Error: Repeated (\d{3})\b/,
];

/**
 * The providers' own sentences, which say a provider refused even with no status beside them. A
 * framework on the AI SDK reports the message alone, and these are not things anything else says.
 */
const SIGNATURE =
  /incorrect api key provided|invalid x-api-key|you didn't provide an api key|api key not valid|invalid 'tools': array too long|maximum context length is|prompt is too long|rate limit reached for|you exceeded your current quota|does not exist or you do not have access to it/i;

const KEY =
  /invalid_api_key|incorrect api key|invalid x-api-key|authentication_error|api key not valid|api_key_invalid|didn't provide an api key|invalid api key|api key is missing|missing api key|invalid authentication/i;
const TOOLS =
  /'tools'[^\n]{0,40}array too long|array_above_max_length[^\n]{0,80}tools|tools[^\n]{0,40}(?:array too long|at most \d+)|too many tools|function[_ ]declarations[^\n]{0,60}(?:at most|too many|maximum)/i;
const TOO_LONG =
  /context_length_exceeded|maximum context length|context window|prompt is too long|input is too long|too many (?:input )?tokens|exceeds the maximum number of tokens/i;
const TOO_LARGE =
  /request_too_large|request too large|payload too large|request entity too large|maximum allowed number of bytes/i;
const RATE =
  /rate[_ ]limit|too many requests|tokens per min|requests per min|resource_exhausted/i;
const MODEL =
  /model_not_found|issue with the selected model|not_found_error[^\n]{0,80}model/i;
const DOWN =
  /overloaded|server_error|internal server error|service unavailable|bad gateway|gateway timeout|temporarily unavailable|server had an error|\bapi_error\b/i;

function statusIn(text: string): number | undefined {
  for (const pattern of STATUS) {
    const found = pattern.exec(text)?.[1];
    const status = found === undefined ? Number.NaN : Number(found);
    if (status >= 400 && status <= 599) return status;
  }
  return undefined;
}

/** The provider's message with the SDK's status prefix taken off. */
function providerWords(text: string): string {
  return text
    .replace(/^Error code: \d{3}\s*-\s*/, "")
    .replace(/^\d{3} (?=\S)/, "")
    .trim();
}

function kindOf(text: string, status: number | undefined): RefusalKind {
  if (BILLING.test(text)) return "billing";
  if (status === 401 || KEY.test(text)) return "key";
  if (TOOLS.test(text)) return "too_many_tools";
  if (TOO_LONG.test(text)) return "too_long";
  if (status === 413 || TOO_LARGE.test(text)) return "too_large";
  if (status === 429 || RATE.test(text)) return "rate_limit";
  if (
    isModelUnavailableMessage(text) ||
    MODEL.test(text) ||
    (status === 404 && /\bmodel\b/i.test(text))
  )
    return "model";
  if ((status !== undefined && status >= 500) || DOWN.test(text))
    return "provider_down";
  return "other";
}

/**
 * The refusal in a harness's RUN_ERROR, or undefined when the text is not a provider's refusal.
 *
 * A refusal is known by a status in the SDK's spelling, by a code a harness of ours sets, or by one
 * of the providers' own sentences. The words then say which kind. Nothing else is taken for one: a
 * Bot that fails in its own words keeps them.
 */
export function readRefusalText(
  text: string,
  code?: string,
): Refusal | undefined {
  if (code === MODEL_BILLING) return undefined;
  const status = statusIn(text);
  if (code === MODEL_AUTH_REQUIRED)
    return { kind: "key", ...(status ? { status } : {}), said: text };
  if (status === undefined && code !== MODEL_REFUSED && !SIGNATURE.test(text))
    return undefined;
  return {
    kind: kindOf(text, status),
    ...(status ? { status } : {}),
    said: providerWords(text),
  };
}

/**
 * The refusal in an error a run threw, or undefined when it is not a provider's refusal.
 *
 * A built-in Bot's model call throws the AI SDK's `APICallError`, with the status and the provider's
 * body on it, or a `RetryError` around several of them. A signed-in plan's model is a harness, whose
 * RUN_ERROR arrives as an error with the harness's code on it (`plan-model.ts`).
 */
export function readRefusal(error: unknown): Refusal | undefined {
  const links = chain(error);
  for (const link of links) {
    if (link.name === "OpenBotModelAuthenticationError")
      return { kind: "key", said: String(link.message ?? "") };
    if (link.name === "AI_LoadAPIKeyError")
      return { kind: "key", said: String(link.message ?? "") };
  }
  for (const link of links) {
    const status = link.statusCode;
    if (typeof status !== "number" || status < 400 || status > 599) continue;
    const said =
      bodyMessage(link.responseBody) ??
      (typeof link.message === "string" ? link.message : "");
    const body = typeof link.responseBody === "string" ? link.responseBody : "";
    return { kind: kindOf(`${said} ${body}`, status), status, said };
  }
  for (const link of links) {
    if (typeof link.message !== "string") continue;
    const refusal = readRefusalText(
      link.message,
      typeof link.code === "string" ? link.code : undefined,
    );
    if (refusal) return refusal;
  }
  return undefined;
}

/** Who refused, told from the provider's own words, for a Bot whose provider this server can't know. */
export function providerFromText(text: string): string | undefined {
  if (/openai\.com|platform\.openai/i.test(text)) return "OpenAI";
  if (/anthropic|claude\.com|x-api-key/i.test(text)) return "Anthropic";
  if (
    /googleapis|generativelanguage|RESOURCE_EXHAUSTED|API_KEY_INVALID/.test(
      text,
    )
  )
    return "Google";
  if (/\bx\.ai\b|console\.x\.ai/i.test(text)) return "xAI";
  return undefined;
}

/** The sentence a person reads: what happened, with whom, and the one thing to do. */
export function refusalSentence(
  refusal: Refusal,
  { provider, signIn }: RefusingProvider,
): string {
  const who =
    provider === "Your model provider" ? "your model provider" : provider;
  switch (refusal.kind) {
    case "key":
      return signIn
        ? `${provider} didn't accept your sign-in. Sign in to ${who} again, then resend your message.`
        : `${provider} didn't accept the API key. Check that it's set, correct and still active, then try again.`;
    case "billing":
      return billingMessage(provider, refusal.said);
    case "rate_limit":
      return `${provider} is limiting how many requests this account can send. Wait a minute, then try again.`;
    case "model":
      return `${provider} doesn't offer the model this Bot uses, or this account can't use it. Choose another model, then try again.`;
    case "too_many_tools":
      return `${provider} turned down the request because this Bot has more tools than the model accepts. Remove some of this Bot's apps, then try again.`;
    case "too_long":
      return `${provider} turned down the request because this conversation is too long for the model. Start a new conversation, then try again.`;
    case "too_large":
      return `${provider} turned down the request because it was too large. Remove some attachments or start a new conversation, then try again.`;
    case "provider_down":
      return `${provider} is having problems right now. Wait a few minutes, then try again.`;
    case "other":
      // The personal edition has no admin to ask: the one person there can choose the model.
      return currentEdition() === "personal"
        ? `${provider} turned down the request. Try again, or choose another model if it keeps happening.`
        : `${provider} turned down the request. Try again, or ask an admin if it keeps happening.`;
  }
}

export class ModelRefusedError extends Error {
  constructor(sentence: string, options: { cause: unknown }) {
    super(sentence, options);
    this.name = "ModelRefusedError";
  }
}

/** The provider's words go here, where somebody diagnosing a refusal reads them. */
function logRefusal(
  bot: { id: string },
  provider: string,
  refusal: Refusal,
  raw: string,
): void {
  console.error(
    JSON.stringify({
      type: "model-provider-refused",
      bot: bot.id,
      provider,
      kind: refusal.kind,
      ...(refusal.status ? { status: refusal.status } : {}),
      error: raw,
    }),
  );
}

/**
 * A run's stream, with a provider's refusal said in words: in the RUN_ERROR a surface draws, and in
 * the error the run ends with.
 *
 * `who` is the provider this deployment runs the Bot on. Absent, for a Bot somebody else runs, the
 * provider is told from its own words when they name it.
 *
 * `untilError` is for a built-in Bot, whose model call sends its RUN_ERROR with the provider's bare
 * message and then throws the error that carries the status. The event waits for that error, so it
 * can be told from the error, which says more than the text.
 */
export function sayingProviderRefusals(
  stream: Observable<BaseEvent>,
  bot: { id: string },
  who: RefusingProvider | undefined,
  { untilError = false }: { untilError?: boolean } = {},
): Observable<BaseEvent> {
  const providerFor = (raw: string): RefusingProvider =>
    who ?? {
      provider: providerFromText(raw) ?? "Your model provider",
      signIn: false,
    };
  const fromText = (event: BaseEvent): BaseEvent => {
    const { message, code } = event as { message?: unknown; code?: unknown };
    if (typeof message !== "string") return event;
    const refusal = readRefusalText(
      message,
      typeof code === "string" ? code : undefined,
    );
    if (!refusal) return event;
    const provider = providerFor(message);
    logRefusal(bot, provider.provider, refusal, message);
    return {
      ...event,
      message: refusalSentence(refusal, provider),
    } as BaseEvent;
  };
  /** The sentence for a thrown error, or undefined when it is not a provider's refusal. */
  const fromError = (error: unknown): Error | undefined => {
    const raw = error instanceof Error ? error.message : String(error);
    const provider = providerFor(raw);
    // The billing sentence keeps its own reader, which prefers the provider's body to a retry count.
    const billing = billingRefusal(error, provider.provider);
    if (billing) {
      logRefusal(
        bot,
        provider.provider,
        { kind: "billing", said: billing.message },
        raw,
      );
      return billing;
    }
    const refusal = readRefusal(error);
    if (!refusal) return undefined;
    logRefusal(bot, provider.provider, refusal, raw);
    return new ModelRefusedError(refusalSentence(refusal, provider), {
      cause: error,
    });
  };

  return new Observable<BaseEvent>((subscriber) => {
    let held: BaseEvent | undefined;
    const flush = () => {
      if (!held) return;
      subscriber.next(fromText(held));
      held = undefined;
    };
    const subscription = stream.subscribe({
      next: (event) => {
        if (event.type === "RUN_ERROR" && untilError) {
          flush();
          held = event;
          return;
        }
        flush();
        subscriber.next(event.type === "RUN_ERROR" ? fromText(event) : event);
      },
      error: (error: unknown) => {
        const said = fromError(error);
        if (held) {
          subscriber.next(
            said
              ? ({ ...held, message: said.message } as BaseEvent)
              : fromText(held),
          );
          held = undefined;
        }
        subscriber.error(said ?? error);
      },
      complete: () => {
        flush();
        subscriber.complete();
      },
    });
    return () => subscription.unsubscribe();
  });
}
