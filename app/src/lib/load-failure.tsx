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
 * Such a 503 is asked again by itself after its `Retry-After`, and again after each refusal while the
 * hold lasts (query-client.ts), so the screen fills in when OpenBot is back without the person doing
 * anything.
 *
 * AND IT IS NOT DRAWN AS A FAILURE. The app keeps the destructive red for what failed or deletes. A
 * move or a brief outage is neither: it is temporary, and OpenBot is already waiting it out. So the
 * server's sentence comes back as muted text (`data-held`), which wins over the red of the line the
 * screen drew it in. The screen's own sentence keeps the screen's own look.
 */
import type { ReactNode } from "react";
import { ClientError } from "@/lib/client";
import { cn } from "@/lib/utils";

/**
 * The server's own sentence when `error` is a 503 that carries one and a `Retry-After`.
 *
 * Or, when `error` was thrown because of one (its `cause`), the error's own longer sentence that
 * folds it in: "It's saved on the Routines page, but it didn't start. OpenBot is moving this
 * organization. Try again in a moment." is still OpenBot holding off, so it is drawn calmly too.
 */
export function unavailableSaid(error: unknown): string | undefined {
  if (
    error instanceof ClientError &&
    error.status === 503 &&
    error.retryAfterMs !== undefined
  )
    return error.said;
  return error instanceof Error &&
    !(error instanceof ClientError) &&
    error.message &&
    error.cause instanceof ClientError &&
    unavailableSaid(error.cause) !== undefined
    ? error.message
    : undefined;
}

/** Whether `failed` (or one of several reads) is OpenBot holding off for now, not a failure. */
export function isHeld(failed: unknown | readonly unknown[]): boolean {
  return heldSaid(failed) !== undefined;
}

/**
 * A failure said in a box of its own, above or beside what it is about: the box the app draws in
 * red for what failed, and in the muted colours of a notice for OpenBot holding off (a move, or a
 * database briefly out of reach). A box drawn by hand around {@link failureSaid} kept its red border
 * and fill around calm words (Admin, Computers). Nothing when there is no error.
 *
 * `own` is the screen's own sentence for a real failure; without it the error's own words are said.
 */
export function FailureNotice({
  error,
  own,
  className,
}: {
  error: unknown;
  own?: string;
  className?: string;
}): ReactNode {
  if (!error) return null;
  const held = isHeld(error);
  const words =
    own ??
    (error instanceof Error && error.message
      ? error.message
      : typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "Something went wrong. Try again in a moment.");
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        held
          ? "border-border bg-muted/40 text-muted-foreground"
          : "border-destructive/40 bg-destructive/10",
        className,
      )}
      data-held={held ? "" : undefined}
      role="alert"
    >
      {loadFailure(error, words)}
    </p>
  );
}

/** The server's own sentence for the first of `failed` that is such a 503, if any is. */
function heldSaid(failed: unknown | readonly unknown[]): string | undefined {
  const errors: readonly unknown[] = Array.isArray(failed) ? failed : [failed];
  for (const error of errors) {
    const said = unavailableSaid(error);
    if (said) return said;
  }
  return undefined;
}

/**
 * What a screen shows for a failed read: the server's own sentence for a 503 that carries one and a
 * `Retry-After`, drawn calm and muted, and `own` otherwise, in the screen's look. Given several reads,
 * the first such 503 speaks for them all.
 */
export function loadFailure(
  failed: unknown | readonly unknown[],
  own: string,
): ReactNode {
  const said = heldSaid(failed);
  return said === undefined ? (
    own
  ) : (
    <span className="text-muted-foreground" data-held="">
      {said}
    </span>
  );
}

/**
 * What a place that says a failure in the error's own words (`{error.message}`) draws instead: the
 * same words for a real failure, in the place's own look, and the server's sentence drawn calm for a
 * 503 that says when to come back, as {@link loadFailure} does. Every failure the app draws in its
 * own words goes through here, so no page can draw a move or a brief outage as a failure
 * (failure-said.test.ts holds the app to it). Nothing when there is no error.
 */
export function failureSaid(
  error: { readonly message: string } | null | undefined,
): ReactNode {
  return error ? loadFailure(error, error.message) : null;
}

/**
 * A failure kept to be drawn later through {@link failureSaid}: what a press that failed keeps in its
 * state, in place of the words alone.
 *
 * A press (export the audit log, add someone to a team, create a Bot) used to keep only the error's
 * words in its state and draw them in red later. The words alone can't say whether
 * they were a hold's, so a move or a brief outage was drawn as a failure. Kept as one of these, the
 * server's own refusal is kept whole and `failureSaid` draws it calmly; anything else draws as before.
 */
export type Failure = { readonly message: string };

/**
 * What a press keeps when it fails: the error itself, so `failureSaid` can tell a hold from a
 * failure and draw the error's own words for a real one, or `otherwise` when what was thrown isn't
 * an error with words of its own.
 */
export function failureOf(thrown: unknown, otherwise: string): Failure {
  return thrown instanceof Error && thrown.message
    ? thrown
    : { message: otherwise };
}

/**
 * What a press keeps when it fails and says so in its own sentence: the server's refusal, kept whole,
 * when it is a hold (to be drawn calmly), and `own` for anything else.
 */
export function failureInstead(thrown: unknown, own: string): Failure {
  return unavailableSaid(thrown) === undefined
    ? { message: own }
    : (thrown as ClientError);
}

/** A toast's type for `error`: a hold is told calmly, as news, and only a failure as an error. */
export function failureToastType(error: unknown): "error" | "info" {
  return unavailableSaid(error) === undefined ? "error" : "info";
}

/**
 * The same choice as {@link loadFailure}, as plain words, for a place that takes a string (a title,
 * a prop typed `string`). A place that draws it should draw a held 503 calmly too.
 */
export function loadFailureText(
  failed: unknown | readonly unknown[],
  own: string,
): string {
  return heldSaid(failed) ?? own;
}

/**
 * How long to wait before asking again, when the refusal is a 503 that said (`Retry-After`): the
 * read is then asked again by itself after that long, each time it is refused, and not retried at
 * once before.
 */
export function askAgainAfterMs(error: unknown): number | undefined {
  return error instanceof ClientError && error.status === 503
    ? error.retryAfterMs
    : undefined;
}
