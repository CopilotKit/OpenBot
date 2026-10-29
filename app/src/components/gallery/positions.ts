/**
 * List items paired with a key for their position.
 *
 * A gallery component is drawn from arguments that are still arriving, so a label is often half
 * typed: keyed on it, "Re", "Rev" and "Revenue" were three different items, each torn down and
 * rebuilt as the next chunk came in, and two items that were briefly both "Q" shared a key. The
 * model writes a list in order and only ever appends to it, so an item's position is the one thing
 * about it that does not change while it streams.
 */
export function byPosition<T>(items: readonly T[]): { item: T; key: string }[] {
  return items.map((item, position) => ({ item, key: `at-${position}` }));
}
