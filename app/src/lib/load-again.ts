import type { AnyRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** What the gate's pending component draws while a page standing in for the app loads it again. */
let standingIn: ReactNode = null;

/**
 * The page standing in for the app while it loads the app again, for the sign-in gate's pending component to draw in
 * place of the app's frame. Null the rest of the time.
 */
export function standingInWhileLoadingAgain(): ReactNode {
  return standingIn;
}

/**
 * Loads the open page again, from a page that stood in for it after the sign-in gate's answer (OpenBot holding off,
 * somebody in no organization), and keeps that page up until the app is ready.
 *
 * `router.invalidate()` puts the failed match back to pending, and the router draws that match's pending component at
 * once, whatever `pendingMs` says, before the first question is even answered. The gate's is the app's empty frame,
 * or nothing for somebody who was never signed in, so the page saying "Trying again…" was replaced by it for as long
 * as the questions took. So the questions are asked first by a preload, which draws nothing (the gate only reads when
 * it preloads) and keeps their answers in the cache. When it fails again with the answer the page already stands for
 * (`stays`), nothing is loaded and the page stays as it is: what failed is returned, for the page to say and to wait
 * on. Otherwise the page is loaded again, answered from the cache, with `meanwhile` (the page as it looks while it
 * tries) drawn by the gate's pending component for the moment that takes. Undefined once the page has been loaded.
 *
 * `reset` clears the error boundary the page was drawn in, first.
 */
export async function loadAgainWhenAnswered({
  router,
  stays,
  meanwhile,
  reset,
}: {
  router: AnyRouter;
  stays: (failed: unknown) => boolean;
  meanwhile: ReactNode;
  reset?: () => void;
}): Promise<{ failed: unknown } | undefined> {
  const { pathname, search, hash } = router.state.location;
  const matches = await router.preloadRoute({ to: pathname, search, hash });
  const failed = matches?.find((match) => match.status === "error");
  if (failed && stays(failed.error)) return { failed: failed.error };
  standingIn = meanwhile;
  try {
    reset?.();
    await router.invalidate();
  } finally {
    if (standingIn === meanwhile) standingIn = null;
  }
  return undefined;
}
