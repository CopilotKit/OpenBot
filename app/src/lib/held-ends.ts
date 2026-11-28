/**
 * A press that OpenBot held off (a move, or the organization's database briefly out of reach) is said
 * calmly where it was pressed: a message sent from home, a turn in a conversation. That sentence is
 * about now, and it stayed after the organization was back (30 seconds and more in the end-to-end
 * test of database sharding), so the screen still said "OpenBot is moving this organization" over a
 * working organization. It goes once the organization answers again.
 *
 * The organization is asked again after the server's `Retry-After`, and again after each new one,
 * with a small read every address of the organization answers (the person, `/people/me`). An answer
 * that isn't a hold, whatever it is, is the organization answering. A request that couldn't be made
 * says nothing, and it is asked again.
 */
import { useEffect, useRef } from "react";
import { getPerson } from "@/lib/api/generated/people/people";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { askAgainAfterMs, isHeld } from "@/lib/load-failure";

/** How long to wait when a hold didn't say (`Retry-After`), or a request couldn't be made. */
const ASK_AGAIN_MS = 10_000;

/** Ask the organization whether it answers again: a small read through the app's own client. */
function askOrganization(): Promise<unknown> {
  return getPerson(organizationId(), "me");
}

/**
 * Calls `ended` once the organization answers again after `held`. Nothing when `held` isn't a hold.
 * Returns how to stop asking.
 */
export function whenHoldEnds(
  held: unknown,
  ended: () => void,
  ask: () => Promise<unknown> = askOrganization,
): () => void {
  if (!isHeld(held)) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (after: unknown) => {
    // The hold's own Retry-After, or the one of the hold it was thrown for (`cause`).
    const wait =
      askAgainAfterMs(after) ??
      (after instanceof Error ? askAgainAfterMs(after.cause) : undefined);
    timer = setTimeout(check, wait ?? ASK_AGAIN_MS);
  };
  const check = async () => {
    if (stopped) return;
    try {
      await ask();
      if (!stopped) ended();
    } catch (error) {
      if (stopped) return;
      if (error instanceof ClientError && !isHeld(error)) ended();
      else later(isHeld(error) ? error : held);
    }
  };
  later(held);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** `whenHoldEnds` for a screen: `clear` runs once the organization answers again after `failure`. */
export function useClearWhenHoldEnds(
  failure: unknown,
  clear: () => void,
): void {
  const cleared = useRef(clear);
  cleared.current = clear;
  useEffect(() => whenHoldEnds(failure, () => cleared.current()), [failure]);
}
