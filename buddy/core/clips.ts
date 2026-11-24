import type { BuddyClips, PoseClips } from "./types";

/**
 * Normalize a BuddyClips value — either a pose→src map or an array of
 * `{ pose, src }` — into a plain pose→url map, dropping empty entries. The one
 * implementation shared by all three framework adapters.
 */
export function toPoseClips(clips: BuddyClips): PoseClips {
  const map: PoseClips = {};
  if (Array.isArray(clips)) {
    for (const c of clips) if (c && c.pose && c.src) map[c.pose] = c.src;
    return map;
  }
  for (const k in clips) {
    const v = clips[k];
    if (v) map[k] = v;
  }
  return map;
}
