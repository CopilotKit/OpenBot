import type { AnyRouter } from "@tanstack/react-router";
import { type ReactNode, useSyncExternalStore } from "react";

/** What the gate's pending component draws while a page standing in for the app loads it again. */
let standingIn: ReactNode = null;
/** How many loads again are under way, from their first question to the app being ready or the page staying. */
let underWay = 0;
/** Who is told when a load again starts or ends. */
const watchers = new Set<() => void>();

/**
 * The page standing in for the app while it loads the app again, for the sign-in gate's pending component to draw in
 * place of the app's frame. Null the rest of the time.
 */
export function standingInWhileLoadingAgain(): ReactNode {
  return standingIn;
}

/** Whether a page standing in for the app is loading it again right now. */
export function loadingAgain(): boolean {
  return underWay > 0;
}

function watchLoadingAgain(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => watchers.delete(onChange);
}

/**
 * Whether a page standing in for the app is loading it again, for that page to say "Trying again…" when it is drawn
 * afresh meanwhile: by a boundary below the gate's, which draws it again on `reset` while the page loads.
 */
export function useLoadingAgain(): boolean {
  return useSyncExternalStore(watchLoadingAgain, loadingAgain, loadingAgain);
}

function startedOrEnded(by: 1 | -1): void {
  underWay += by;
  for (const watcher of watchers) watcher();
}

/**
 * Loads the open page again, from a page that stood in for it after OpenBot's answer (holding off, somebody in no
 * organization), and keeps that page up, saying "Trying again…", until the app is ready.
 *
 * `router.invalidate()` puts the failed match back to pending, and the router draws that match's pending component at
 * once, whatever `pendingMs` says, before the first question is even answered. The gate's is the app's empty frame,
 * or nothing for somebody who was never signed in, so the page saying "Trying again…" was replaced by it for as long
 * as the questions took. So the questions are asked first by a preload, which draws nothing (the gate only reads when
 * it preloads) and keeps their answers in the cache. When it fails again with the answer the page already stands for
 * (`stays`), nothing is loaded and the page stays as it is: what failed is returned, for the page to say and to wait
 * on. Otherwise the page is loaded again, answered from the cache. Undefined once the page has been loaded.
 *
 * While it loads, the page is drawn one of two ways. Stood in for at the gate, `meanwhile` (the page as it looks
 * while it tries) is drawn by the gate's pending component. Stood in for by a page inside the app, its boundary keeps
 * it, drawn afresh by `reset`, and the page reads `useLoadingAgain` to say "Trying again…" there too.
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
  startedOrEnded(1);
  try {
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
  } finally {
    startedOrEnded(-1);
  }
}
