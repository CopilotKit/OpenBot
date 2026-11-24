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
const listeners = new Set<() => void>();

function tell(): void {
  for (const listener of listeners) listener();
}

/** Open the dialog. Already open, nothing changes. */
export function showCardNeeded(): void {
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

/** Whether a refusal's problem body is a run refused for want of a plan. */
export function isPlanRequired(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === PLAN_REQUIRED
  );
}
