/**
 * One model call for a few words. Not a Bot and not a turn: a title is not said to anybody and is
 * not part of the conversation it names, so there is no runtime work and no thread to hold.
 */
import { oneLine } from "./text";

/** Where an OpenAI-compatible provider answers, overridable the way `agent-bot` overrides it. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Rules, not an example: a model copies an example's subject as readily as its shape. */
const INSTRUCTION = [
  "You name conversations, like a title in a sidebar.",
  "Answer with three to six words naming what the conversation is about.",
  "No quotation marks, no trailing period, no prefix such as 'Conversation about'.",
  "Name the subject itself, not the fact that somebody asked about it.",
].join(" ");

export type TitlerOptions = {
  /** The model to ask, from the tenant package. */
  model: string;
  /** Resolved per call, so a rotated credential is picked up without a restart. */
  resolveApiKey: () => Promise<string | null>;
  baseUrl?: string;
  /** Injectable so a test drives this without a network. */
  fetchImpl?: typeof fetch;
  /** How long one call may take before it is given up on. */
  timeoutMs?: number;
};

/** No key resolves to null and is not retried; a provider error throws, so the queue retries it. */
export function createChannelTitler(options: TitlerOptions) {
  const call = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  return async (excerpt: string): Promise<string | null> => {
    const apiKey = await options.resolveApiKey();
    if (!apiKey) return null;

    const response = await call(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: INSTRUCTION },
          { role: "user", content: excerpt },
        ],
        // Reasoning tokens come out of this budget, so a cap sized for the answer alone 400s.
        max_completion_tokens: 512,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (!response.ok) {
      // Capped: this lands on the work item's row, and an HTML error page would land there whole.
      const detail = oneLine(await response.text().catch(() => ""), 200);
      throw new Error(
        `The model refused to name a conversation: ${response.status} ${detail}`.trim(),
      );
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const answer = content.trim();
    return answer.length > 0 ? answer : null;
  };
}
