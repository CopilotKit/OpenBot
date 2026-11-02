import { parseSearchWith } from "@tanstack/react-router";

/**
 * Reading a search parameter that is TEXT, when the router has already decided it was something
 * else.
 *
 * THE ROUTER JSON-PARSES EVERY SEARCH VALUE. `?connected=notion` stays the string it looks like
 * only because `notion` is not valid JSON; `?flow_id=12345` arrives as the number 12345 and
 * `?flow_id={"a":1}` as an object, because both of those are. Nothing in the URL said so — whether
 * a value survives as text depends entirely on what characters the sender's id generator happened
 * to emit, which is why a `typeof value === "string"` guard works for every handle in testing and
 * silently drops a fraction of the real ones.
 *
 * SO NOTHING HERE GUARDS ON THE PARSED TYPE; it renders whatever came back to the text it was in
 * the URL. There is no shape a sender can choose that falls through to "no parameter", so the
 * wrong case is gone by construction rather than by a list of types to also accept — the same
 * answer the notice table on the connected-accounts screen gives for keys off a URL.
 */

/**
 * The text a search value was in the URL, or undefined when the parameter was not there at all.
 *
 * Exact for everything `parseSearchText` lets through: a string is itself, a number is one it
 * round-trips through (see below), and an object or array is re-rendered as the JSON it was parsed
 * from. The empty string is a value, not an absence — a parameter present and empty is passed on as
 * such, for whoever reads it to call unusable.
 */
export function searchText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return String(value);
  /*
   * An object or array can only have got here by having been JSON in the URL, so stringifying it is
   * reading that JSON back. `JSON.stringify` answers undefined rather than text for values it
   * cannot render; none of those can come out of `JSON.parse`, and the check is here so that a
   * future parser which can is a missing parameter rather than the string "undefined".
   */
  const text = JSON.stringify(value);
  return typeof text === "string" ? text : undefined;
}

/**
 * That text under its key, or nothing — ready to spread into what `validateSearch` returns.
 *
 * The key is OMITTED rather than set to undefined, for the reason the routes using this give:
 * present-but-undefined makes `search` a required prop on every Link to the route, which is a lot
 * of ripple for a parameter only a callback sets.
 */
export function searchTextEntry<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const text = searchText(value);
  return text === undefined ? {} : ({ [key]: text } as Record<Key, string>);
}

/**
 * The router's own parser, with the one case `searchText` could not have rendered back taken away.
 *
 * `JSON.parse` turns `12345678901234567890` into a double, and no amount of care downstream can
 * recover the digits that rounding threw away — a handle like that would come back out of
 * `searchText` as a DIFFERENT handle, which is worse than dropping it. So a number whose text form
 * is not the text it was parsed from is left as that text, and every number that does reach a route
 * is one `String` renders back exactly. `1e3` keeps its spelling for the same reason.
 */
export const parseSearchText: (searchStr: string) => Record<string, unknown> =
  parseSearchWith((value: string) => {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "number" && String(parsed) !== value
      ? value
      : parsed;
  });
