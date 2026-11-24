/**
 * What a screen says when a read failed.
 *
 * A screen names what it couldn't load in its own sentence ("Couldn't load your routines. Try again in
 * a moment."), which is right for a server that broke: the reason is OpenBot's, and the person only
 * needs to know what is missing. A 503 that carries a sentence AND says when to ask again
 * (`Retry-After`) is different. It is OpenBot saying why it is holding off for now ("OpenBot is moving
 * this organization. Try again in a moment."), and that sentence is the one to read. Memory showed it
 * and Routines didn't, because Memory drew the error's own message and Routines drew its own words.
 * Every screen asks here instead.
 *
 * Only with `Retry-After`: a 503 without one is something that broke or isn't there (a proxy, a
 * service OpenBot depends on, "Service unavailable."), and the screen's own sentence says it better.
 *
 * Such a 503 is asked again once, by itself, after its `Retry-After` (query-client.ts), so the screen
 * fills in when OpenBot is back without the person doing anything.
 */
import { ClientError } from "@/lib/client";

/** The server's own sentence when `error` is a 503 that carries one and a `Retry-After`. */
export function unavailableSaid(error: unknown): string | undefined {
  return error instanceof ClientError &&
    error.status === 503 &&
    error.retryAfterMs !== undefined
    ? error.said
    : undefined;
}

/**
 * The sentence a screen shows for a failed read: the server's own for a 503 that carries one and a
 * `Retry-After`, and `own` otherwise. Given several reads, the first such 503 speaks for them all.
 */
export function loadFailure(
  failed: unknown | readonly unknown[],
  own: string,
): string {
  const errors: readonly unknown[] = Array.isArray(failed) ? failed : [failed];
  for (const error of errors) {
    const said = unavailableSaid(error);
    if (said) return said;
  }
  return own;
}

/**
 * How long to wait before asking again, when the refusal is a 503 that said (`Retry-After`): the
 * read is then asked again once by itself after that long, and not retried at once before.
 */
export function askAgainAfterMs(error: unknown): number | undefined {
  return error instanceof ClientError && error.status === 503
    ? error.retryAfterMs
    : undefined;
}
