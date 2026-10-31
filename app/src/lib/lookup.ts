// app/src/lib/lookup.ts
/**
 * ONE home for "read a table by a key somebody else chose".
 *
 * WHY THIS EXISTS. A catalogue slug, a component name, a report id and a verifier's status code all
 * arrive from outside this build, and every one of them was at some point used to index a plain
 * object literal. An object literal indexed that way answers `toString`, `constructor`, `valueOf`
 * and `__proto__` with a member inherited from `Object.prototype` — truthy, so it walks straight
 * past the `?? fallback` and the `if (hit)` guard that were supposed to catch "not in the table",
 * and hands the caller a Function where it expected a component, a sentence or a row. That crash
 * was fixed once, in the connected-accounts page, with a `Map`; the fix was documented there and
 * nowhere else, and the next table went back to an object literal.
 *
 * So the prototype-safe read is a named function rather than a habit: `keyedLookup(TABLE, key)`
 * reads the same whichever page writes it and keeps the prototype-safe read in one place.
 *
 * A `Map` answers only with what was PUT IN IT. That is the whole mechanism; this function adds
 * nothing to it but a name. Taking a `ReadonlyMap` is the point — passing an object literal is a
 * type error, which is the only way a rule like this survives the next table.
 */

/**
 * The value stored at `key`, or `undefined` when the table holds no such key.
 *
 * Behaviourally identical to `map.get(key)`, deliberately: the callers below each keep their own
 * `?? fallback`, because what a missing key should draw or say is the page's decision and not this
 * function's.
 */
export function keyedLookup<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
): V | undefined {
  return map.get(key);
}
