import { queryOptions } from "@tanstack/react-query";
import { everyPage } from "@/lib/api/every-page";
import {
  getAppSetup,
  listAppDirectory,
  listApps,
} from "@/lib/api/generated/apps/apps";
import type {
  App,
  AppSetup,
  CatalogueAppEntry,
  DirectoryAppEntry,
} from "@/lib/api/generated/model";
import { organizationId } from "@/lib/api/request";

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
  list: () => ["plugins", "apps", "list"] as const,
  catalogue: () => ["plugins", "apps", "catalogue"] as const,
  directory: (search: string) =>
    ["plugins", "apps", "directory", { search }] as const,
};

/** The most a page holds, so a whole list takes as few requests as it can. */
const PAGE = 100;

/**
 * How apps are set up on this OpenBot: whether the directory is available and which service it
 * comes from (the screens pick their own directory page by it), the address an admin registers with
 * an app's vendor, and whether a Bot can use an app's actions without a key of its own.
 */
export function appSetupQueryOptions() {
  return queryOptions({
    queryKey: appKeys.setup(),
    queryFn: ({ signal }): Promise<AppSetup> =>
      getAppSetup(organizationId(), {
        signal,
        fallback: "Couldn't load how apps are set up",
      }),
    // A deployment setting: it changes only when an admin changes the server's configuration.
    staleTime: 5 * 60_000,
  });
}

/**
 * Every app added here, with the actions each offers and the Bots that may use each one: every page
 * of listApps, by title. The screens look apps up by id in it, so it is read whole.
 */
export function appsQueryOptions() {
  return queryOptions({
    queryKey: appKeys.list(),
    queryFn: ({ signal }): Promise<App[]> =>
      everyPage(async (cursor) => {
        const page = await listApps(
          organizationId(),
          { limit: PAGE, ...(cursor ? { cursor } : {}) },
          {
            signal,
            fallback: "Couldn't load your apps. Try again in a moment.",
          },
        );
        return { items: page.apps, nextCursor: page.nextCursor };
      }),
  });
}

/** One entry of OpenBot's own catalogue, as the screens draw it. */
export type CatalogueItem = Omit<
  CatalogueAppEntry,
  "id" | "source" | "appId"
> & {
  /** The entry's key, which is also the id of the app it is added as. */
  key: string;
};

/** The catalogue's entry ids are `catalogue:<key>`; the key is what the screens and app ids use. */
export function catalogueKey(entryId: string): string {
  return entryId.replace(/^catalogue:/, "");
}

/**
 * OpenBot's own catalogue: every entry this edition offers, and any already added whatever the
 * edition, in the catalogue's order. Anybody signed in may read it.
 */
export function catalogueQueryOptions() {
  return queryOptions({
    queryKey: appKeys.catalogue(),
    queryFn: async ({ signal }): Promise<CatalogueItem[]> => {
      const entries = await everyPage(async (cursor) => {
        const page = await listAppDirectory(
          organizationId(),
          { source: "catalogue", limit: PAGE, ...(cursor ? { cursor } : {}) },
          {
            signal,
            fallback: "Couldn't load your apps. Try again in a moment.",
          },
        );
        return { items: page.entries, nextCursor: page.nextCursor };
      });
      return entries
        .filter(
          (entry): entry is CatalogueAppEntry => entry.source === "catalogue",
        )
        .map(({ id, source: _source, appId: _appId, ...entry }) => ({
          ...entry,
          key: catalogueKey(id),
        }));
    },
  });
}

/** One app of the wider directory, as the picker shows it. */
export type DirectoryApp = DirectoryAppEntry;

/**
 * The wider directory an admin adds apps from, searched by name or description: every page of
 * listAppDirectory with source=directory. `appId` names the app an entry was added as.
 */
export function directoryAppsQueryOptions(search: string) {
  return queryOptions({
    queryKey: appKeys.directory(search),
    queryFn: async ({ signal }): Promise<DirectoryApp[]> => {
      const entries = await everyPage(async (cursor) => {
        const page = await listAppDirectory(
          organizationId(),
          {
            source: "directory",
            limit: PAGE,
            ...(search ? { search } : {}),
            ...(cursor ? { cursor } : {}),
          },
          {
            signal,
            fallback:
              "Couldn't load the apps you can connect. Try again in a moment.",
          },
        );
        return { items: page.entries, nextCursor: page.nextCursor };
      });
      return entries.filter(
        (entry): entry is DirectoryAppEntry => entry.source === "directory",
      );
    },
  });
}

/** The directory's entry ids are `directory:<slug>`; the slug is what an app's own page is about. */
export function directorySlug(entryId: string | null): string | null {
  return entryId?.startsWith("directory:")
    ? entryId.slice("directory:".length)
    : null;
}
