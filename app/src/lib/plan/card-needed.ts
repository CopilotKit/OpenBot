/**
 * Whether the dialog that says Bots can't run without a card is open (`CardNeededDialog`).
 *
 * One dialog for the whole app, opened from wherever a person tries something that uses the AI:
 * the check in front of every action that starts a run (`stopIfNeedsCard` in `./queries`), and any
 * refusal the server sends for want of a plan (PLAN_REQUIRED, 402), from a REST call
 * (`lib/client.ts`) or a run of a Bot (`lib/copilot/stopped-turn.ts`). Closing it lasts until the
 * next such try.
 *
 * No imports from the app, so the transport can report to it without a cycle.
 */

/** The refusal's code when a run is refused for want of a plan: the API's `PlanRequired`. */
export const PLAN_REQUIRED = "PLAN_REQUIRED";

let shown = false;
/**
 * Where the last refusal said to add a card: the server sends it only to an owner or an admin. Kept
 * so the dialog knows who it is talking to at once, before the plan it reads again has answered.
 */
let refusedAddCardUrl: string | null = null;
const listeners = new Set<() => void>();

function tell(): void {
  for (const listener of listeners) listener();
}

/**
 * Open the dialog. Already open, nothing changes but what a refusal said. `refusal` is the server's
 * PLAN_REQUIRED problem when that is what opened it.
 */
export function showCardNeeded(refusal?: unknown): void {
  if (refusal !== undefined) refusedAddCardUrl = addCardUrlOf(refusal);
  if (shown) return;
  shown = true;
  tell();
}

/** Close it, until the next try. */
export function hideCardNeeded(): void {
  if (!shown) return;
  shown = false;
  tell();
}

/** For `useSyncExternalStore`. */
export function subscribeCardNeeded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cardNeededShown(): boolean {
  return shown;
}

/** Where the last PLAN_REQUIRED refusal said to add a card, or null (a member, or no refusal). */
export function refusalAddCardUrl(): string | null {
  return refusedAddCardUrl;
}

/** Forget what a refusal said. For tests, which share one module. */
export function forgetCardNeededRefusal(): void {
  refusedAddCardUrl = null;
}

/** Whether a refusal's problem body is a run refused for want of a plan. */
export function isPlanRequired(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === PLAN_REQUIRED
  );
}

function addCardUrlOf(body: unknown): string | null {
  const url =
    body && typeof body === "object"
      ? (body as { addCardUrl?: unknown }).addCardUrl
      : undefined;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Where this browser remembers the dialog has opened by itself, once, for a person in an
 * organization: after that it opens only when they try something that uses the AI, a reload, a
 * link opened afresh and coming Back from the payment page included.
 */
const ANNOUNCED_KEY = "openbot.trial-used-up.announced";

/** In this page, for a browser that keeps nothing (private windows, storage turned off). */
const announcedHere = new Set<string>();

function announcedKey(personId: string, organizationId: string): string {
  return `${ANNOUNCED_KEY}:${personId}:${organizationId}`;
}

/** Whether the dialog has already opened by itself for this person in this organization. */
export function trialUsedUpAnnounced(
  personId: string,
  organizationId: string,
): boolean {
  const key = announcedKey(personId, organizationId);
  if (announcedHere.has(key)) return true;
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/** Remember it has, in this page and in this browser where it keeps anything. */
export function rememberTrialUsedUpAnnounced(
  personId: string,
  organizationId: string,
): void {
  const key = announcedKey(personId, organizationId);
  announcedHere.add(key);
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Remembered for this page only.
  }
}

/**
 * Forget every announcement. For tests, which share one module and one storage: `"page"` forgets
 * only what this page held, as loading it again does.
 */
export function forgetTrialUsedUpAnnounced(
  what: "page" | "everywhere" = "everywhere",
): void {
  announcedHere.clear();
  if (what === "page") return;
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith(`${ANNOUNCED_KEY}:`))
        window.localStorage.removeItem(key);
  } catch {
    // Nothing kept to forget.
  }
}
