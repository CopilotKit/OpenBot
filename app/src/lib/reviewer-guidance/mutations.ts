import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteReviewerGuidance,
  replaceReviewerGuidance,
} from "@/lib/api/generated/reviewer-guidance/reviewer-guidance";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { reviewerGuidanceKeys } from "./queries";

const FALLBACK = "The guidance for auto-review couldn't be saved.";

const invalidateGuidance = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: reviewerGuidanceKeys.all });

/**
 * Save the guidance. The server reads the words again and refuses them, saying why, unless they still
 * read as guidance; then it records the save on the trail with the words and the reading.
 */
export const saveReviewerGuidanceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (text: string) =>
      replaceReviewerGuidance(
        ORGANIZATION_ID,
        { text },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () => invalidateGuidance(queryClient),
  });

/** Remove the guidance, so the reviewer reads only its own instructions again. Recorded on the trail. */
export const removeReviewerGuidanceMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: () =>
      deleteReviewerGuidance(
        ORGANIZATION_ID,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "The guidance for auto-review couldn't be removed." },
      ),
    onSuccess: () => invalidateGuidance(queryClient),
  });
