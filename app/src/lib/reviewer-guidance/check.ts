import { client } from "@/lib/client";
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
  const response = await client("/api/approvals/team/guidance/check", {
    method: "POST",
    body: { text },
    fallback: "Couldn't check the guidance. Try again.",
  });
  return (await response.json()) as GuidanceReading;
}

/**
 * The reviewer, with these words, over the requests people decided. One model call a request, so it
 * runs only when the admin asks, after being told how many. Writes nothing.
 */
export async function backtestReviewerGuidance(
  text: string,
): Promise<GuidanceBacktest> {
  const response = await client("/api/approvals/team/guidance/backtest", {
    method: "POST",
    body: { text },
    fallback: "Couldn't test the guidance on recent requests.",
  });
  return (await response.json()) as GuidanceBacktest;
}
