import { withCurrentFrameworkNames } from "@openbot/shared/harnesses";

/**
 * A Bot's subtitle as a person reads it: the Personal Assistant's seed shows Atai's wording, and a
 * "Powered by" OpenBot wrote under a framework's earlier name shows its current one.
 *
 * Display only, and so applied where a subtitle is drawn, never where the profile is read. What the
 * server returns is the stored subtitle, which is what the Bot is told (its standing role, a voice
 * call), what a New Bot interview reads, and what an edit sends back. Mapping it on the server would
 * change all of those, and an edit to any other field would store the new wording.
 */
export function shownSubtitle(title: string): string;
export function shownSubtitle(title: string | undefined): string | undefined;
export function shownSubtitle(title: string | undefined): string | undefined {
  // A roster entry can arrive without one (an older server, a group's roster): drawn as before.
  if (!title) return title;
  return withCurrentFrameworkNames(title);
}
