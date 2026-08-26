/**
 * Which entries under the profiles root are Bots.
 *
 * ITS OWN MODULE SO ONE ANSWER SERVES BOTH SIDES. The rule lived inline in `profiles.ts`, and the
 * test that covered it had a second copy: delete the production filter and the suite stayed green,
 * because it was checking its own copy rather than the shipped one. A predicate worth testing is
 * worth importing.
 *
 * Free of Playwright on purpose. `profiles.ts` launches browsers, so a test that wanted this rule had
 * to drag a browser runtime in with it, which is most of why the copy existed in the first place.
 */
import { isPlainBotId } from "./bot-id";

/** The shape of a directory entry, as both `readdir` and a test can supply it. */
export type ProfileEntry = { name: string; isDirectory: () => boolean };

/**
 * The Bot ids among a directory listing, sorted and deduplicated.
 *
 * ONLY ENTRIES THIS CODE COULD HAVE MADE. The root is a mounted volume, and a volume is not an empty
 * directory: a real disk formatted ext4 arrives with `lost+found` already in it, so on a cloud the
 * fleet page listed a Bot by that name, offered to reset it, and nobody could say where it came from.
 * Never seen locally, because a bind mount and kind's local-path volumes have no such directory,
 * which is exactly the shape of bug that ships.
 *
 * `isPlainBotId` is the same allow-list that stops a hostile id becoming a path, used here for the
 * other half of the question: an entry it would refuse to create is not one of ours to list.
 */
export function botIdsIn(entries: readonly ProfileEntry[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => isPlainBotId(entry.name))
        .map((entry) => entry.name),
    ),
  ].sort();
}
