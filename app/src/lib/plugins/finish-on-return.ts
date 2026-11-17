import { VERIFIER_PATH } from "@/lib/auth/resume";
import { desktopShell } from "@/lib/desktop/shell";

/** The step waiting for the window to be back in front, while there is one. */
let waiting: (() => void) | null = null;

/**
 * Finish an app's consent at the verifier once OpenBot Desktop's window is back in front.
 *
 * Where each action is authorized on its own, a consent ends at the verifier, which checks that the
 * person finishing it is the one signed in. The window sends the consent to the person's default
 * browser, which is not signed in to the OpenBot on this computer: the server holds what that browser
 * brought back and sends it to the page that hands the person back to the window (`/desktop-return`).
 * So the window, which is signed in, opens the verifier itself when the person comes back to it,
 * with no handle of its own, and the server finishes the one it held and sends the window on to the
 * app's page.
 *
 * Once per consent: a second consent before the window was back in front waits on the same step. Not
 * tied to the screen that started it, because the consent is still waiting to be finished if the
 * person has moved on. In a browser the consent comes back to the verifier itself, so nothing waits.
 */
export function finishOnReturn(): void {
  if (!desktopShell() || waiting) return;
  const finish = () => {
    waiting = null;
    window.location.href = VERIFIER_PATH;
  };
  waiting = finish;
  window.addEventListener("focus", finish, { once: true });
}

/**
 * The same, in the background, for a consent started where the window must stay where it is: the
 * card in a conversation (`useConnectInNewTab`), which is in the middle of something.
 *
 * Asked once the window is back in front, without following where the verifier sends it: the
 * request carries the window's own credentials, the server finishes what it held, and the caller then
 * reads the connections again. Where nothing is held, or the consent was one the verifier does not
 * finish, it refuses with a redirect and writes nothing. Settles either way, and never in a browser,
 * where the consent comes back to the verifier itself.
 */
export async function finishInBackground(): Promise<void> {
  if (!desktopShell()) return;
  try {
    await fetch(VERIFIER_PATH, {
      credentials: "same-origin",
      redirect: "manual",
    });
  } catch {
    // Nothing to tell anybody: the connections read that follows says whether it was finished.
  }
}
