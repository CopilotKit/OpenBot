import type { ControlState } from "@/lib/computers/control";

/**
 * Whether the secret request a Bot is waiting on is over.
 *
 * By its id where the computer gives one: a different request in its place, or none at all, means
 * this one has ended. A computer too old to give ids is read the way it always was, by the box going
 * away.
 */
export function secretRequestOver(
  id: string | undefined,
  state: ControlState,
): boolean {
  return id ? state.secretId !== id : state.secretWanted === undefined;
}

/**
 * What the Bot is told once its secret request is over.
 *
 * TYPED ONLY WHEN THE COMPUTER SAYS SO. The request ends for other reasons too: a person takes
 * control, the browser restarts, its time runs out. Every one of those used to reach the Bot as "the
 * person has entered it", and it pressed Sign in on an empty password. Now only `secretEnded` naming
 * this request as supplied is an answer; anything else is said as nothing typed, with the reason the
 * computer gave, and the Bot is told not to submit the form.
 */
export function secretAnswer(
  label: string,
  id: string | undefined,
  outcome: "answered" | "gave up" | "cancelled",
  last: ControlState | null,
): { ok: boolean; result: string } {
  if (outcome === "cancelled")
    return { ok: true, result: "The request was cancelled." };
  const notTyped = (why: string) => ({
    ok: false,
    result: `Nobody entered ${label}: ${why} Nothing was typed into the field, so don't submit the form. Tell the person, and ask again with computer_request_secret if you still need it.`,
  });
  if (outcome === "gave up")
    return notTyped("nobody answered the masked box in time.");
  const ended = last?.secretEnded;
  if (!id || (ended?.id === id && ended.supplied))
    return {
      ok: true,
      result: `The person has entered ${label} into the field. It was typed straight into the page and you were not told what it is.`,
    };
  return notTyped(
    ended?.id === id && ended.reason
      ? ended.reason
      : "the request ended before anything was typed.",
  );
}
