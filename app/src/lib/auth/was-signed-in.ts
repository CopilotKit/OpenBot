/**
 * Whether somebody was signed in the last time this browser used the app.
 *
 * Only somebody signed in last time gets the app frame while the sign-in checks run, so a visitor
 * never sees an app frame flash before the sign-in screen. Storage that cannot be read counts as
 * never signed in, which shows the plain loading state: the safe way to be wrong.
 */
const KEY = "openbot-was-signed-in";

/** Whether somebody was signed in the last time this browser used the app. */
export function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember that somebody is signed in, for the next time the app opens. */
export function rememberSignedIn(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // No storage here: the next visit shows the plain loading state instead of the frame.
  }
}

/** Forget it, once nobody is signed in any more. */
export function forgetSignedIn(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // No storage here: there is nothing kept that could show the frame to a visitor.
  }
}
