/**
 * Gemini's thought signatures on tool calls, kept on every path a call takes back to Gemini.
 *
 * THE RULE (https://ai.google.dev/gemini-api/docs/thought-signatures): Gemini 3 gives the first
 * function call of each step an opaque thought signature, and refuses with a 400 ("Function call
 * is missing a thought_signature in functionCall parts") any request whose current turn, every
 * step since the person's latest message, has a step whose first call comes back without it.
 *
 * Natively (@langchain/google) the signature is the call part's `thoughtSignature`, which the
 * converter reads and writes as the LangChain call's `thoughtSignature`. On Google's
 * OpenAI-compatible Chat Completions API, which OpenBot's model gateway and a Gemini key saved as
 * an OpenAI-compatible endpoint both use, it is the tool call's
 * `extra_content.google.thought_signature`: on the call's delta as it streams, and on the call in
 * the assistant message sent back. @langchain/openai knows nothing of it: it never reads it from an
 * answer, and rebuilds every call it sends from the LangChain call alone. FOUND ON OPENBOT CLOUD:
 * every Bot on Gemini stopped at the second tool step of a turn with that 400, since each step is a
 * run of its own and the call came back from the thread with no signature.
 *
 * So the engine reads the signature off the streamed call (`signatureOfDelta`), carries it the
 * AG-UI way like the native one (`encryptedValue` on the call, `run.ts`), and puts it back on the
 * call it sends (`ChatCompletionsWithSignatures`). Only to a Gemini model: another provider is
 * never sent Gemini's artefact.
 *
 * A step whose first call has no signature on record (a thread from before this fix, or calls made
 * on another provider's model earlier in the turn) is sent, to a Gemini that checks, Google's
 * documented placeholder for calls it did not generate, so the conversation goes on instead of
 * being refused at every message.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions } from "@langchain/openai";

/** Google's documented value for a call it did not generate, which skips the check. */
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

/** Whether a model name is one of Google's Gemini models, as Google's own APIs name them. */
export function isGeminiModel(model: string | undefined): boolean {
  return /^(models\/)?gemini-/i.test((model ?? "").trim());
}

/** The signature a LangChain call carries, as @langchain/google and this engine put it there. */
export function signatureOf(call: unknown): string | undefined {
  const value = (call as { thoughtSignature?: unknown } | undefined)
    ?.thoughtSignature;
  return typeof value === "string" && value ? value : undefined;
}

/** The signature on an OpenAI-compatible tool call or its streamed delta, from Gemini. */
export function signatureOfDelta(raw: unknown): string | undefined {
  const value = (
    raw as
      | { extra_content?: { google?: { thought_signature?: unknown } } }
      | undefined
  )?.extra_content?.google?.thought_signature;
  return typeof value === "string" && value ? value : undefined;
}

/** Whether the model checks signatures: Gemini 3 on. Gemini 1 and 2 never asked for them. */
export function checksSignatures(model: string | undefined): boolean {
  return (
    isGeminiModel(model) &&
    !/^(models\/)?gemini-[12](\.|-)/i.test((model ?? "").trim())
  );
}

/**
 * Each step's first call signed, for a model that checks: its own signature, or Google's
 * placeholder when it has none on record. Gemini checks only the first call of a step; the rest
 * keep what they have. Any other model is sent the steps as they are.
 */
export function signedSteps(
  messages: readonly BaseMessage[],
  model: string | undefined,
): BaseMessage[] {
  if (!checksSignatures(model)) return [...messages];
  return messages.map((message) => {
    if (message.getType() !== "ai") return message;
    const ai = message as AIMessage;
    const first = ai.tool_calls?.[0];
    if (!first || signatureOf(first)) return ai;
    return new AIMessage({
      id: ai.id,
      content: ai.content as never,
      tool_calls: [
        { ...first, thoughtSignature: GEMINI_SKIP_SIGNATURE } as never,
        ...(ai.tool_calls ?? []).slice(1),
      ],
      additional_kwargs: ai.additional_kwargs,
      response_metadata: ai.response_metadata,
    });
  });
}

type WireCall = { id?: string; extra_content?: unknown };
type WireMessage = { role?: string; tool_calls?: WireCall[] };

/**
 * LangChain's Chat Completions client, sending each call's thought signature back to Gemini.
 *
 * The converter turns each assistant message with calls into one assistant message with
 * `tool_calls`, in order and call for call, so the request's calls are matched to the messages'
 * calls by position, and by id where both have one.
 */
export class ChatCompletionsWithSignatures extends ChatOpenAICompletions {
  /** The signatures of the request being sent: per assistant step with calls, per call. */
  private steps: (string | undefined)[][] = [];
  private stepIds: (string | undefined)[][] = [];

  private remember(messages: BaseMessage[]): void {
    const steps = isGeminiModel(this.model)
      ? signedSteps(messages, this.model)
      : [];
    const withCalls = steps.filter(
      (message) =>
        message.getType() === "ai" && (message as AIMessage).tool_calls?.length,
    ) as AIMessage[];
    this.steps = withCalls.map((ai) =>
      (ai.tool_calls ?? []).map((call) => signatureOf(call)),
    );
    this.stepIds = withCalls.map((ai) =>
      (ai.tool_calls ?? []).map((call) => call.id),
    );
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: Parameters<ChatOpenAICompletions["_generate"]>[2],
  ) {
    this.remember(messages);
    return super._generate(messages, options, runManager);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: Parameters<ChatOpenAICompletions["_streamResponseChunks"]>[2],
  ) {
    this.remember(messages);
    yield* super._streamResponseChunks(messages, options, runManager);
  }

  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: Parameters<ChatOpenAICompletions["_streamChatModelEvents"]>[2],
  ) {
    this.remember(messages);
    yield* super._streamChatModelEvents(messages, options, runManager);
  }

  // biome-ignore lint/suspicious/noExplicitAny: one body for both of the SDK's overloads.
  override completionWithRetry(request: any, requestOptions?: any): any {
    if (isGeminiModel(request?.model) && Array.isArray(request?.messages)) {
      let step = 0;
      request = {
        ...request,
        messages: (request.messages as WireMessage[]).map((message) => {
          if (message.role !== "assistant" || !message.tool_calls?.length)
            return message;
          const sealed = this.steps[step] ?? [];
          const ids = this.stepIds[step] ?? [];
          step += 1;
          return {
            ...message,
            tool_calls: message.tool_calls.map((call, index) => {
              const at = call.id ? ids.indexOf(call.id) : -1;
              const signature = sealed[at >= 0 ? at : index];
              return signature
                ? {
                    ...call,
                    extra_content: { google: { thought_signature: signature } },
                  }
                : call;
            }),
          };
        }),
      };
    }
    return super.completionWithRetry(request, requestOptions);
  }
}
