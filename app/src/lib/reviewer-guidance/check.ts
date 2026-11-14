import {
  checkReviewerGuidance as checkReviewerGuidanceRequest,
  replayReviewerGuidance,
} from "@/lib/api/generated/reviewer-guidance/reviewer-guidance";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import type { GuidanceBacktest } from "./queries";

/**
 * The guidance read back by a call that saw only the words: what it changes, and whether it reads as
 * guidance at all. Only guidance that does can be saved.
 */
export type GuidanceReading = {
  summary: string | null;
  explanation: string;
  check: { ok: true } | { ok: false; error: string };
};

/** The longest guidance the server takes. */
export const GUIDANCE_LIMIT = 2000;

/**
 * Words in, a reading out. A plain function: nothing is saved and nothing is cached, and saving is
 * still the admin's own act.
 */
export async function checkReviewerGuidance(
  text: string,
): Promise<GuidanceReading> {
  const reading = await checkReviewerGuidanceRequest(
    ORGANIZATION_ID,
    { text },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't check the guidance. Try again." },
  );
  // `check` carries its error exactly when it is not ok.
  return reading as GuidanceReading;
}

/**
 * The reviewer, with these words, over the requests people decided. One model call a request, so it
 * runs only when the admin asks, after being told how many. Writes nothing.
 */
export function backtestReviewerGuidance(
  text: string,
): Promise<GuidanceBacktest> {
  return replayReviewerGuidance(
    ORGANIZATION_ID,
    { text },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "Couldn't test the guidance on recent requests." },
  );
}
