/**
 * The page's `fetch`, for a test whose page is addressed at a real HTTP server on this computer.
 *
 * A browser resolves a request's path against the page's address and aborts it on the page's own
 * signal. Under happy-dom the page's `AbortSignal` is happy-dom's, which the runtime's `fetch`
 * refuses, so the abort is carried over to one of the runtime's own. Everything else is the
 * runtime's real request, on the real network stack.
 *
 * Captured when this module loads, before a test file registers happy-dom.
 */
const nativeFetch = globalThis.fetch;
const NativeAbortController = globalThis.AbortController;

export function pageFetch(): typeof fetch {
  return Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const target =
        typeof input === "string" ? new URL(input, location.href) : input;
      const given = init?.signal;
      if (!given) return nativeFetch(target, init);
      const controller = new NativeAbortController();
      if (given.aborted) controller.abort();
      else
        given.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      return nativeFetch(target, { ...init, signal: controller.signal });
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
}

export { nativeFetch };
