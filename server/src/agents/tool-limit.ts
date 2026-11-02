/**
 * How many tools a built-in Bot's model provider accepts in one request, and the sentence a run
 * gets instead of a model call when it would send more.
 *
 * FOUND LIVE. Approving General Assistant's access to Shopify granted it 239 read-only actions in
 * one click, taking it to 279 tools. OpenAI refuses a request carrying more than 128
 * (`Invalid 'tools': array too long. Expected an array with maximum length 128`), and on the
 * Responses API path that run ended at once with an empty finish: "Thinking" for a moment, then
 * nothing, on every message, with no error in the transcript, the audit trail or the server log.
 * A request the provider is certain to refuse is not worth sending, so it is refused here, before
 * the model call, with a sentence somebody can act on.
 *
 * ONLY LIMITS SOMEBODY CAN CITE. OpenAI's is in its own refusal (`invalid_request_error`, code
 * `array_above_max_length`, "Expected an array with maximum length 128"), and its API reference
 * states the same number elsewhere ("There can be a maximum of 128 tools per assistant"; "A max of
 * 128 functions are supported"). Anthropic documents a cap only for deferred tools (10,000 with `defer_loading`, which
 * nothing here sets) and none for the ordinary `tools` array, so a Claude-backed Bot is not
 * limited here: a guessed number would refuse runs the provider would have taken.
 */

/** The most tools OpenAI accepts in one request. */
export const OPENAI_MAX_TOOLS = 128;

export type ToolLimit = {
  /** The provider, as a person reads it in the refusal. */
  provider: string;
  limit: number;
};

/**
 * The limit a built-in Bot's requests are held to, or null where none is known.
 *
 * OpenAI's limit is OpenAI's: an `OPENAI_BASE_URL` naming any other host (a local server, a
 * gateway, another vendor's OpenAI-compatible endpoint) answers to whatever that host accepts,
 * which this deployment cannot know. OpenAI's own hosts, including the regional
 * `*.api.openai.com` ones, and an unset base URL keep the limit. Azure is left out for the reason
 * Anthropic is: no number this module can cite.
 */
export function toolLimitFor(
  provider: string,
  environment: Record<string, string | undefined> = process.env,
): ToolLimit | null {
  if (provider !== "openai") return null;
  const baseUrl = environment.OPENAI_BASE_URL?.trim();
  if (baseUrl && !isOpenAIHost(baseUrl)) return null;
  return { provider: "OpenAI", limit: OPENAI_MAX_TOOLS };
}

function isOpenAIHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".api.openai.com");
  } catch {
    return false;
  }
}

/**
 * What the person is shown, and what an administrator needs: which Bot, how many, how many fit,
 * and where the fix is. The count is what the run would have sent, which includes the tools the
 * runtime and the client add, so it can be a few more than the Bot's grants.
 */
export function toolLimitRefusal(
  botName: string,
  count: number,
  limit: ToolLimit,
): string {
  return `${botName} was not run: it would be offered ${count} tools, and ${limit.provider} accepts at most ${limit.limit} in one request. An administrator can narrow its grants on the Bot's page.`;
}
