import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import type { Import } from "@/lib/api/generated/model";
import { listImports } from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud";
import { organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

export const moveKeys = {
  all: ["moves"] as const,
  imports: () => ["moves", "imports"] as const,
  importsIn: (organizationId: string) =>
    ["moves", "imports-in", organizationId] as const,
};

/** Every page of the person's own moves into one organization, newest first. */
async function everyImportIn(
  organizationId: string,
  signal: AbortSignal,
): Promise<Import[]> {
  try {
    return await everyPage(async (cursor) => {
      const page = await listImports(
        organizationId,
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { signal, fallback: "Couldn't load your moves to OpenBot Cloud." },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    });
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) return [];
    throw error;
  }
}

/**
 * The person's own moves into another of their organizations than the one they work in, by the
 * same rules as `importListQueryOptions`. A move goes into the organization the person's sign-in
 * named at the time, which need not be the one this browser works in.
 */
export function importListInQueryOptions(organizationId: string) {
  return queryOptions({
    queryKey: moveKeys.importsIn(organizationId),
    queryFn: ({ signal }) => everyImportIn(organizationId, signal),
  });
}

/**
 * The person's own moves into this organization (listImports), newest first, every page.
 *
 * Only OpenBot Cloud takes a move. Any other OpenBot answers not found (`MOVE_UNAVAILABLE`), and an
 * OpenBot from before moving has no such address at all: both mean there is no move here, so both
 * are read as none, which is an answer and not an error. Any other failure is an error.
 */
export function importListQueryOptions() {
  return queryOptions({
    queryKey: moveKeys.imports(),
    queryFn: ({ signal }) => everyImportIn(organizationId(), signal),
  });
}
