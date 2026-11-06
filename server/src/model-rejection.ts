/**
 * The signal that a provider refused a model as unknown, retired or not one this credential can
 * use, so the model list is read again at once rather than at its next scheduled refresh.
 *
 * Its own module with no imports, because the stream observers that raise it are imported almost
 * everywhere, the browser app's type check included, and the model list itself is not light.
 */

/**
 * Whether a provider's refusal says the model itself is the problem: unknown, retired, or not one
 * this credential can use. The ChatGPT plan's "The 'gpt-5.5' model is not supported when using Codex
 * with a ChatGPT account" is the case that taught it.
 */
export function isModelUnavailableMessage(text: string): boolean {
  return (
    /model_not_found|model[_ ]not[_ ]supported|unknown model|invalid model|unsupported model/i.test(
      text,
    ) ||
    /\bmodel\b[^\n]{0,80}?\b(is not supported|not supported|does not exist|not found|is not available|no longer available|has been deprecated|has been retired|is retired)\b/i.test(
      text,
    )
  );
}

const rejectionListeners = new Set<() => void>();

/** Called when a provider refuses a model as unavailable. See {@link isModelUnavailableMessage}. */
export function onModelRejected(listener: () => void): () => void {
  rejectionListeners.add(listener);
  return () => rejectionListeners.delete(listener);
}

/** Tells every catalogue a model was refused, so they refresh early. Cheap; debounced by each. */
export function reportModelRejected(): void {
  for (const listener of rejectionListeners) listener();
}
