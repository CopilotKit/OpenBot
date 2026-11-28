/**
 * WHERE SOMEBODY WAS HEADED WHEN THE GATE SENT THEM TO ONBOARDING, carried through it as `?next=`.
 *
 * The signed-in gate (`routes/_authed.tsx`) sends somebody who has to finish onboarding, or connect
 * their own AI first (OpenBot Cloud), to `/onboarding` from wherever they were going. Without the
 * destination they landed on home once done: an app's Reconnect after the move to OpenBot Cloud went
 * through Connect your AI and ended on the chat, nowhere near the app (reported on 1.2.0-rc.1).
 *
 * Only a path on this origin is followed, so the address can't send anybody off the app, and
 * onboarding itself is never the destination.
 */
export function onboardingDestination(next: unknown): string | undefined {
  if (typeof next !== "string") return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return undefined;
  if (next === "/" || next === "/onboarding") return undefined;
  if (next.startsWith("/onboarding?") || next.startsWith("/onboarding/"))
    return undefined;
  return next;
}

/** Where onboarding's last button goes: the destination it was given, else home. */
export function afterOnboarding(next: unknown): string {
  return onboardingDestination(next) ?? "/";
}
