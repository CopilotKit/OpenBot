/**
 * The person's account scheduled to be deleted, found out while the app is open: once the person
 * asks for it here, or from the first request refused ACCOUNT_PENDING_DELETION. From then the app
 * shows only the pending page (`PendingDeletionGate`), which says when and offers to cancel.
 *
 * On a load the router finds it out instead (routes/_authed.tsx, lib/error-reporting.tsx).
 *
 * Imports nothing of the app, so the query client can call it.
 */

/**
 * How the pending page and the delete dialog load the app afresh. A test replaces it to see it asked.
 */
export const pendingPageDeps = {
  openHome: () => window.location.assign("/"),
  openSignIn: () => window.location.assign("/sign"),
};

/** The API's code for every request from somebody whose account is scheduled to be deleted. */
export const ACCOUNT_PENDING_DELETION = "ACCOUNT_PENDING_DELETION";

/**
 * Whether a failure is the API saying the person's account is scheduled to be deleted. An answer,
 * not a fault: every request but reading the deletion and cancelling it says the same until it is
 * cancelled, so it is never retried (query-client.ts) and is answered with the pending page.
 *
 * Read by the refusal's code alone, with nothing imported, so the query client can ask it.
 */
export function pendingDeletionRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ACCOUNT_PENDING_DELETION
  );
}

/** What the pending page knows: when the account goes, when it was said. */
export type PendingDeletion = { deleteAfter?: string };

let pending: PendingDeletion | undefined;
const listeners = new Set<() => void>();

/** The deletion the app is showing, or undefined while it shows the app. */
export function pendingDeletion(): PendingDeletion | undefined {
  return pending;
}

/** The account is scheduled to be deleted: the app gives way to the pending page. */
export function showPendingDeletion(deletion: PendingDeletion = {}): void {
  if (pending !== undefined && !deletion.deleteAfter) return;
  pending = deletion;
  for (const listener of [...listeners]) listener();
}

/** The deletion was cancelled: the app comes back. */
export function clearPendingDeletion(): void {
  if (pending === undefined) return;
  pending = undefined;
  for (const listener of [...listeners]) listener();
}

/** Hear the pending deletion begin or end. Returns how to stop hearing. */
export function onPendingDeletionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/*
 * Signing in again to delete the account. The API asks for a sign-in from the last 10 minutes
 * (REAUTHENTICATE); the person signs out and in again, and the app opens the delete dialog again
 * where they left it. Kept in this tab's session storage, with when it was asked, so a sign-in
 * long after (or another person's, on a shared machine) does not open it.
 *
 * Never a return address: the place it opens is fixed (General settings), so nothing that arrives
 * in a URL decides where the app goes.
 */
const RESUME = "openbot-delete-account-resume";
/** How long after asking a sign-in still opens the dialog again. */
const RESUME_WINDOW_MS = 30 * 60_000;

/** What the browser keeps, kept here so a test can stand in for it. */
export const resumeDeps = {
  now: () => Date.now(),
  storage: (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  },
};

/** The person is leaving to sign in again: open the delete dialog when they are back. */
export function resumeDeletionAfterSignIn(): void {
  try {
    resumeDeps.storage()?.setItem(RESUME, String(resumeDeps.now()));
  } catch {
    // Nowhere to keep it: back from signing in, they open the dialog themselves.
  }
}

/** Whether the person came back from signing in again to delete their account. */
export function deletionToResume(): boolean {
  const asked = Number(resumeDeps.storage()?.getItem(RESUME) ?? 0);
  return asked > 0 && resumeDeps.now() - asked < RESUME_WINDOW_MS;
}

/** The dialog is open again: it opens once. */
export function deletionResumed(): void {
  try {
    resumeDeps.storage()?.removeItem(RESUME);
  } catch {
    // Taken for this page either way.
  }
}
