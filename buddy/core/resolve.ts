import type { PoseClips } from "./types.ts";

/**
 * Resolve which pose id to actually play for a (possibly custom) pose.
 *
 * Precedence: the custom clip if the buddy has it → the fallback pose if given
 * and present → the fallback id as intent (or the custom id) so the controller's
 * own clip→home fallback finishes the job. This is the single resolver that
 * replaces the copy-pasted `resolve()` helpers across the docs and examples;
 * pass `fallbackId` from a CustomPoseDef's `fallback` (or a per-call override).
 */
export function resolvePose(
  poseUrls: PoseClips,
  customId: string,
  fallbackId?: string,
): string {
  if (poseUrls[customId]) return customId;
  if (fallbackId && poseUrls[fallbackId]) return fallbackId;
  return fallbackId ?? customId;
}
