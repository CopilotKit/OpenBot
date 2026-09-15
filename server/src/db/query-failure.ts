/**
 * What a failed query may be quoted as, for every module that quotes one.
 *
 * WHY THIS IS ITS OWN FILE. These three used to be private to `plugins/store.ts`, which is where
 * the first leak was found and fixed. `credentials.ts` then wrote `error.message` into an audit row
 * on the rotation path — the one path whose bound values include the encrypted credential envelope
 * — and the docblock over that write asserted the secret had never left the function. Copying the
 * helper would have made two answers to one question, and importing the store from `credentials.ts`
 * is a cycle: the store already imports `../credentials`. A module under `db/` is what both sides
 * can reach, it is where the shape being described comes from, and it depends on nothing, so it
 * cannot close a loop with anything that needs it.
 */

/**
 * Whether a throw is a query failure carrying the statement and the values bound to it.
 *
 * CRITERION. Anything this answers true for has a message that must never be relayed — not to a
 * model, not to a browser, not into a column an operator reads, and least of all into `audit_events`,
 * which is append-only by trigger and kept for the whole retention window.
 *
 * REASON. drizzle wraps every failure as a `DrizzleQueryError` and puts `Failed query: <the whole
 * statement>` and `params: <every bound value>` in its `message`. Along the tool-call path those
 * values are credential ids, user ids and server ids; along the refresh path they are the vendor's
 * entire tool list; along the credential rotation path they are the encrypted envelope itself.
 *
 * BY SHAPE, NOT BY CLASS, and that is the one place this rule departs from "tell them apart by a
 * class, never by prose". The class is drizzle's, reachable only through a deep import that is not
 * part of its published surface, so an `instanceof` here would pin this deployment to an internal
 * path a minor release may move. `query` and `params` as own properties on an `Error` is not prose
 * — it is the shape the constructor assigns, it is what makes the message dangerous, and anything
 * else carrying both fields is a query failure too.
 */
export function isQueryFailure(
  error: unknown,
): error is Error & { query: unknown; params: unknown } {
  return (
    error instanceof Error &&
    Object.hasOwn(error, "query") &&
    Object.hasOwn(error, "params")
  );
}

/**
 * As much of a failure as may be shown to whoever is entitled to see it.
 *
 * CRITERION. Every place that copies a message out of a caught error asks this instead of reading
 * `.message`. What comes back never contains a statement or a bound value.
 *
 * REASON. The message is the useful thing for a vendor's refusal, a person's missing connection or
 * an invariant of ours — that is why those paths quote it, and they should go on quoting it. It is
 * the wrong thing for exactly one kind of error, and that kind announces itself by shape. Asking
 * here rather than at each site means a new audience cannot be added without the question already
 * answered for it.
 */
export function withoutStatement(error: Error): string {
  return isQueryFailure(error) ? databaseComplaint(error) : error.message;
}

/**
 * The same answer for a throw that may not be an `Error` at all.
 *
 * A `catch` binds `unknown`, and the reflex at those sites is
 * `error instanceof Error ? error.message : String(error)` — which reads `.message` directly and so
 * walks straight past {@link withoutStatement}. This is that expression with the question already
 * asked, so a site handling an unknown throw has no reason to write the unsafe half out again.
 */
export function reasonWithoutStatement(error: unknown): string {
  return error instanceof Error ? withoutStatement(error) : String(error);
}

/**
 * The driver's own complaint about a query, without the query.
 *
 * CRITERION. What this returns never contains the statement or the values bound to it.
 *
 * REASON. drizzle's `DrizzleQueryError` puts both in its own `message` and hangs the driver's
 * error off `cause`. The driver's message is the useful half — `duplicate key value violates
 * unique constraint`, `invalid byte sequence`, `canceling statement due to statement timeout` —
 * and it is the half that names nothing anybody sent. An error shaped differently gets a fixed
 * sentence rather than its own message, because the reason this exists is that a message from an
 * unexamined shape is exactly what leaked the last one.
 *
 * Capped where every other quoted failure is capped, for the same reason: parts of it come from
 * somewhere else and none of it is a promise about length.
 */
export function databaseComplaint(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error
    ? cause.message.slice(0, 400)
    : "The database gave no reason this deployment can quote.";
}
