import { knowShortenedToolNames } from "@openbot/shared/tool-name";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { getShortenedToolNames } from "@/lib/api/generated/apps/apps";
import { ORGANIZATION_ID } from "@/lib/api/request";

/**
 * What shortened tool names stand for, so a step is drawn by the action's own name.
 *
 * A long app action travels under a name cut to 64 characters and ended with a hash, and its step
 * read "Update dimensi 82883606". The server pairs each cut name with the whole one
 * (getShortenedToolNames); they are learned before the first conversation is drawn (`_authed`'s
 * `beforeLoad`), so no step is ever drawn by its cut name first.
 *
 * NEVER IN THE WAY. A server that does not answer, or does not know the question, leaves the names
 * as they are: steps read as they did, and the app opens.
 */
export const shortenedToolNamesQueryOptions = () =>
  queryOptions({
    queryKey: ["plugins", "tool-names"] as const,
    // An app added later brings its own long names; a minute is soon enough to learn them.
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<Record<string, string>> => {
      try {
        const body = await getShortenedToolNames(ORGANIZATION_ID, { signal });
        const names =
          body.names && typeof body.names === "object" ? body.names : {};
        knowShortenedToolNames(names);
        return names;
      } catch {
        return {};
      }
    },
  });

/** Learn the names, waiting no longer than `withinMs` for them. */
export async function learnShortenedToolNames(
  queryClient: QueryClient,
  withinMs = 3_000,
): Promise<void> {
  await Promise.race([
    queryClient
      .ensureQueryData({
        ...shortenedToolNamesQueryOptions(),
        revalidateIfStale: true,
      })
      .catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, withinMs)),
  ]);
}
