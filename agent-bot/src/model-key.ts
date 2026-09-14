/**
 * Whether this Bot needs a model key, checked before it starts.
 *
 * Its own module because `index.ts` serves at module scope, so importing it to reach one pure
 * function binds a port.
 */

/**
 * A key is required unless an endpoint was named to answer instead.
 *
 * `OPENAI_BASE_URL` set means any endpoint speaking that API, and Ollama, vLLM, LM Studio and
 * llama.cpp all serve it with no key. The setup window offers exactly those by name and accepts a
 * blank key for them, so requiring one here exited this Bot on startup for every one of them.
 */
export function keyIsRequired(baseUrl: string | undefined): boolean {
  return !baseUrl?.trim();
}

/**
 * What to hand the SDK, which insists on a string even when the endpoint ignores it.
 *
 * A placeholder rather than an empty string: empty is a client that cannot be constructed.
 */
export function apiKeyOrPlaceholder(apiKey: string | undefined): string {
  return apiKey?.trim() || "no-key-needed";
}
