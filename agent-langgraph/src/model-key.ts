/**
 * Whether this Bot needs a model key, checked before it starts.
 *
 * Its own module for the reason `model-options.ts` is: `index.ts` calls `serve()` at module scope,
 * so importing it to reach one pure function binds a port.
 */

/** The environment variable each provider's key arrives in. */
export const KEY_VARIABLE: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * A key is required unless an endpoint was named to answer instead.
 *
 * `OPENAI_BASE_URL` set means any endpoint speaking that API, and Ollama, vLLM, LM Studio and
 * llama.cpp all serve it with no key at all. The setup window offers exactly those by name and
 * accepts a blank key for them, so requiring one here exited this Bot on startup for every one of
 * them: the person filled in an address and got a dead container complaining about a key their
 * server does not have. Two ends of one feature disagreeing.
 *
 * Only the OpenAI branch has a base URL to be named by, so nothing changes for the other two.
 */
export function keyIsRequired(
  provider: string,
  baseUrl: string | undefined,
): boolean {
  const named = provider === "openai" && Boolean(baseUrl?.trim());
  return !named;
}

/**
 * What to hand the SDK, which insists on a string even when the endpoint ignores it.
 *
 * A placeholder rather than an empty string: empty is a client that cannot be constructed, and the
 * value is never sent anywhere that reads it.
 */
export function apiKeyOrPlaceholder(apiKey: string | undefined): string {
  return apiKey?.trim() || "no-key-needed";
}
