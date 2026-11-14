import { queryOptions } from "@tanstack/react-query";
import { getAppSetup } from "@/lib/api/generated/apps/apps";
import type { AppSetup } from "@/lib/api/generated/model";
import { ORGANIZATION_ID } from "@/lib/api/request";

/**
 * The apps this OpenBot has added, the directory it adds them from, and how apps are set up here,
 * read through the API's generated client.
 *
 * Every key sits under `["plugins"]`, so `invalidatePlugins` (lib/plugins/mutations.ts) refreshes
 * these reads with everything else an app change touches.
 */
export const appKeys = {
  all: ["plugins", "apps"] as const,
  setup: () => ["plugins", "apps", "setup"] as const,
};

/**
 * How apps are set up on this OpenBot: whether the directory is available and which service it
 * comes from (the screens pick their own directory page by it), the address an admin registers with
 * an app's vendor, and whether a Bot can use an app's actions without a key of its own.
 */
export function appSetupQueryOptions() {
  return queryOptions({
    queryKey: appKeys.setup(),
    queryFn: ({ signal }): Promise<AppSetup> =>
      getAppSetup(ORGANIZATION_ID, {
        signal,
        fallback: "Couldn't load how apps are set up",
      }),
    // A deployment setting: it changes only when an admin changes the server's configuration.
    staleTime: 5 * 60_000,
  });
}
