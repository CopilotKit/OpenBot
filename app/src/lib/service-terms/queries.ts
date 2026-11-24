import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { ServiceTerms } from "@/lib/api/generated/model";
import { getServiceTerms } from "@/lib/api/generated/people/people";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { unavailableSaid } from "@/lib/load-failure";

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
 * Whether a failed read is an OpenBot older than this operation, which has no terms: the address
 * is not served, so it is the API's plain not found (`NOT_FOUND`), or a 404 that names no code at
 * all, as `noSuchAddress` reads it in lib/organizations/queries.ts. Every other 404 is a refusal
 * about this request (the person or the organization it names not found) and fails like any other.
 * It says nothing about whether the person agreed, so it never lets them past the terms.
 */
function olderOpenBot(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    (error.code === undefined || error.code === "NOT_FOUND")
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
 *
 * Except a hold: OpenBot moving the organization, or its database out of reach for a moment (503
 * with its sentence and Retry-After, lib/load-failure.tsx). That says nothing about the terms, and
 * somebody who agreed long ago was shown "Agree to the terms". It is thrown on, so the gate's page
 * says the hold calmly ("Back in a moment") and goes on by itself once OpenBot answers, as every
 * other page does. Nobody gets in without the answer.
 */
export async function serviceTermsRequired(
  queryClient: QueryClient,
): Promise<boolean> {
  try {
    return (await queryClient.ensureQueryData(serviceTermsQueryOptions()))
      .acceptanceNeeded;
  } catch (error) {
    if (unavailableSaid(error) !== undefined) throw error;
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
