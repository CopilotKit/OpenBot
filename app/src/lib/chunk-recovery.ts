/**
 * A PART OF THE APP THAT COULDN'T BE LOADED, LOADED AGAIN.
 *
 * The build splits the app into files fetched the first time a screen or a part of one is drawn: a
 * route's component (TanStack Router's code splitting) and the parts a dependency loads lazily, such
 * as Streamdown's code block. Each file's name carries a hash of its contents, and an OpenBot serves
 * only the files of the build it runs. So a page left open across a release asks for a file the
 * new release no longer has, gets a 404, and the import fails. A dropped connection fails it too.
 *
 * FOUND IN OPENBOT DESKTOP ON OPENBOT CLOUD. Back in a conversation after another one, the pane
 * showed the router's own screen, "Something went wrong!" and WebKit's "Importing a module script
 * failed.", and stayed there. A part loaded with React's `lazy` keeps its failure for good, and
 * TanStack Router's own reload for a route's file is remembered per message for the whole session,
 * which in WebKit is the same message for every file, so it reloads at most once per window.
 *
 * What happens instead, from the route's error screen (`components/layout/route-error.tsx`):
 *
 * 1. The OpenBot is asked which build it serves now (its `index.html`, never cached), up to three
 *    times over a few seconds. No answer means the OpenBot can't be reached: loading the page again
 *    would trade this screen for the browser's own "can't connect", so the error screen shows.
 * 2. An answer: the page loads again, once, and gets the build the OpenBot serves, the new one when
 *    a release replaced this page's. Loading the page again is the only retry there is: once an
 *    import of a file failed, Chromium and WebKit fail every later import of it in the same page
 *    without asking the network again.
 * 3. Once per build per ten minutes, so a page that loads again into the same build and fails the
 *    same way (a file that is gone for good, a stale cache in front of the OpenBot) shows the error
 *    screen and does not loop.
 */

/** How each engine words an import whose file didn't load, and Vite's for a stylesheet's. */
const CHUNK_LOAD_MESSAGES = [
  // Chromium, with the file's address after it.
  "Failed to fetch dynamically imported module",
  // Firefox, with the file's address after it.
  "error loading dynamically imported module",
  // WebKit, the engine OpenBot Desktop's Mac window draws with. Never names the file.
  "Importing a module script failed",
  // Vite, when the stylesheet a file brings with it doesn't load.
  "Unable to preload CSS",
];

/** Whether an error is a part of the app's own code that couldn't be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    CHUNK_LOAD_MESSAGES.some((start) => message.startsWith(start))
  );
}

/** The build a document is: the address of its entry script, which carries the build's hash. */
export function entryScriptOf(
  document: ParentNode,
  base: string,
): string | null {
  const src = document
    .querySelector('script[type="module"][src]')
    ?.getAttribute("src");
  if (!src) return null;
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

/** The build this page is. */
export function thisBuild(): string | null {
  return entryScriptOf(document, document.baseURI);
}

/**
 * The build the OpenBot serves now, from its `index.html`, or null when that couldn't be read. The
 * page's own origin: in OpenBot Desktop's window that is the desktop app's relay, which passes it on.
 */
export async function servedBuild(): Promise<string | null> {
  try {
    const response = await fetch("/", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "text/html" },
    });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").includes("text/html"))
      return null;
    const html = await response.text();
    return entryScriptOf(
      new DOMParser().parseFromString(html, "text/html"),
      response.url || window.location.href,
    );
  } catch {
    return null;
  }
}

/**
 * The build a page was on when it last loaded again for a file that didn't load, and when. Kept
 * for the tab's session, which a reload keeps.
 */
export const RELOADED_FROM_BUILD = "openbot:reloaded-from-build";

/** How long a page that loaded again from a build doesn't do it again from the same one. */
export const RELOAD_GUARD_MS = 10 * 60_000;

type SessionStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * Load the page again, unless this page already did from this same build in the last ten minutes.
 * Without the session's storage there is no way to know, so it doesn't.
 */
export function reloadOnceFrom(
  current: string,
  storage: SessionStore | null,
  reload: () => void,
  now = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const last = JSON.parse(storage.getItem(RELOADED_FROM_BUILD) ?? "null") as {
      build?: unknown;
      at?: unknown;
    } | null;
    if (
      last?.build === current &&
      typeof last.at === "number" &&
      now - last.at < RELOAD_GUARD_MS
    )
      return false;
    storage.setItem(
      RELOADED_FROM_BUILD,
      JSON.stringify({ build: current, at: now }),
    );
  } catch {
    return false;
  }
  reload();
  return true;
}

/** The pauses before asking the OpenBot again, when it didn't answer. */
const PROBE_DELAYS_MS = [1_000, 3_000];

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * What to do about a file that didn't load: the page is loading again, or there is nothing left to
 * try by itself and the error screen shows. `stillWanted` is asked before the page is loaded
 * again, so a person who has gone elsewhere meanwhile is not taken back.
 */
export async function recoverChunk(
  stillWanted: () => boolean = () => true,
): Promise<"reloading" | "stuck"> {
  for (let attempt = 0; ; attempt += 1) {
    const served = await servedBuild();
    if (!stillWanted()) return "stuck";
    if (served) {
      const current = thisBuild() ?? served;
      return reloadOnceFrom(current, sessionStore(), () =>
        window.location.reload(),
      )
        ? "reloading"
        : "stuck";
    }
    const delay = PROBE_DELAYS_MS[attempt];
    if (delay === undefined) return "stuck";
    await pause(delay);
  }
}
