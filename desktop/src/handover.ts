/**
 * The window becoming OpenBot after a Start.
 *
 * `show_openbot` sends the window to OpenBot's own page, and the setup page stays on screen until
 * that page replaces it: a second or two, more after an update, when OpenBot's page loads for the
 * first time on its new release. Starting stays on screen meanwhile, as it was. On Windows I the
 * window said "OpenBot is running", with Show OpenBot and Stop OpenBot, for about five seconds
 * between Starting and OpenBot's home.
 *
 * `holdMs`: how long Starting stays once the window was sent to OpenBot. A page that is still here
 * after that was never replaced, and the running screen says so, with Show OpenBot to try again.
 * Tests that are about the running screen itself shorten it.
 *
 * `fadeMs`: how long setup takes to fade out to the window's ground before the window is sent to
 * OpenBot (`leaveFor`). OpenBot's page fades its first paint up from the same ground when setup
 * opened it (`app/src/lib/desktop/from-setup.ts`), so the two read as one dissolve. 0 is no fade,
 * as with reduced motion. Tests that are not about the fade set it to 0.
 *
 * `backMs`: how long setup stays faded once the window was sent to OpenBot. The page normally goes
 * long before: the window drops it as soon as OpenBot's page arrives. One still here after that
 * fades back in, so the window never sits empty while OpenBot is slow to answer.
 */
export const handover = { holdMs: 20_000, fadeMs: 240, backMs: 3_000 };

/** Where the fade is said: `data-handover` on the page's root, and its length in `--handover-fade`. */
const ROOT_MARK = "handover";

let back: ReturnType<typeof setTimeout> | null = null;

function stillMotion(): boolean {
  try {
    return (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
  } catch {
    return false;
  }
}

function mark(value: "leaving" | "back" | null) {
  const root = document.documentElement;
  if (value === null) {
    delete root.dataset[ROOT_MARK];
    root.style.removeProperty("--handover-fade");
  } else {
    root.dataset[ROOT_MARK] = value;
    root.style.setProperty("--handover-fade", `${handover.fadeMs}ms`);
  }
}

/**
 * Setup fades out to the window's ground, and only then `go` sends the window to OpenBot. If `go`
 * fails, setup is back at once, so the failure shows on the screen it was, as before. With reduced
 * motion, or `fadeMs` 0, `go` runs straight away and nothing fades.
 *
 * Once `go` has sent the window, setup stays faded until OpenBot's page replaces it, or fades back
 * in after `backMs` if it is still here.
 */
export async function leaveFor<T>(go: () => Promise<T>): Promise<T> {
  if (back !== null) clearTimeout(back);
  back = null;
  if (handover.fadeMs > 0 && !stillMotion()) {
    mark("leaving");
    await new Promise((done) => setTimeout(done, handover.fadeMs));
  } else {
    mark(null);
  }
  let sent: T;
  try {
    sent = await go();
  } catch (error) {
    mark(null);
    throw error;
  }
  if (document.documentElement.dataset[ROOT_MARK] === "leaving") {
    back = setTimeout(() => {
      mark("back");
      back = setTimeout(() => {
        back = null;
        mark(null);
      }, handover.fadeMs);
    }, handover.backMs);
  }
  return sent;
}
