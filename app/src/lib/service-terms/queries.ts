import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { ServiceTerms } from "@/lib/api/generated/model";
import { getServiceTerms } from "@/lib/api/generated/people/people";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/**
 * The terms of service a person agrees to before they use OpenBot (getServiceTerms): the version in
 * force, the one they last agreed to, and the server's verdict on whether they have to agree now.
 * Only OpenBot Cloud has terms. Everywhere else `current` is null and nobody is asked.
 */
export type { ServiceTerms };

export const serviceTermsKeys = {
  all: ["service-terms"] as const,
  mine: ["service-terms", "mine"] as const,
};

/** What an OpenBot with no terms answers, and what an OpenBot older than the question reads as. */
const NO_TERMS: ServiceTerms = {
  current: null,
  accepted: null,
  acceptanceNeeded: false,
};

/**
 * A 404 that says the person isn't there is about them, and fails like any other refusal. Any
 * other 404 is an OpenBot older than this operation, which has no terms. An organization not found
 * is read the same way: every other read in it fails too, and the app's own page for that answers
 * the person (OrganizationBoundary), where the terms screen would only say it couldn't load.
 */
function olderOpenBot(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    error.code !== "PERSON_NOT_FOUND"
  );
}

/** The person's own terms. An OpenBot without the operation answers as one with no terms. */
export function serviceTermsQueryOptions() {
  return queryOptions({
    queryKey: serviceTermsKeys.mine,
    queryFn: async ({ signal }): Promise<ServiceTerms> => {
      try {
        return await getServiceTerms(organizationId(), "me", {
          signal,
          fallback: "Couldn't load the terms.",
        });
      } catch (error) {
        if (olderOpenBot(error)) return NO_TERMS;
        throw error;
      }
    },
  });
}

/**
 * Whether the person has to see the terms before anything else, for the signed-in gate: the
 * server's verdict, never recomputed from the versions.
 *
 * A read that fails reads as yes. Letting somebody in because the question failed would let an
 * OpenBot Cloud person use it without agreeing, so the terms screen takes them instead, says the
 * read failed and offers Try again. An OpenBot with no terms answers no without failing, and an
 * older one's 404 is read as no terms above, so neither ever shows the screen.
 */
export async function serviceTermsRequired(
  queryClient: QueryClient,
): Promise<boolean> {
  try {
    return (await queryClient.ensureQueryData(serviceTermsQueryOptions()))
      .acceptanceNeeded;
  } catch {
    return true;
  }
}

/**
 * Where the terms screen sends somebody once they agree: the address they were headed to, when it
 * is a page of this app, else home. Only a path on this origin is followed, so the address can't
 * send anybody off the app; the terms screen itself is never the destination.
 */
export function afterTerms(next: unknown): string {
  if (typeof next !== "string") return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\"))
    return "/";
  if (next === "/terms" || next.startsWith("/terms?")) return "/";
  return next;
}
