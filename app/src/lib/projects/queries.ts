import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One of this person's project folders, as the browser sees it.
 *
 * `channelIds` rather than titles, deliberately: the folder is drawn from the roster the sidebar
 * already holds, so the ids are enough to file rows, and a payload that carried names could name a
 * conversation to somebody who cannot open it.
 */
export type Project = {
  id: string;
  name: string;
  /** Where the folder sits in the Projects section. Ties fall back to `createdAt`. */
  sortOrder: number;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
  /** The conversations this person has filed here, in no particular order. */
  channelIds: string[];
};

export const projectKeys = {
  all: ["projects"] as const,
  list: () => ["projects", "list"] as const,
};

/**
 * This person's folders.
 *
 * One read for the whole sidebar: the section, every folder in it, and which conversations are
 * filed where. A server that predates projects answers 404 and the query settles into an error,
 * which the sidebar draws as an empty Projects section rather than as a broken one.
 */
export function projectsQueryOptions() {
  return queryOptions({
    queryKey: projectKeys.list(),
    queryFn: ({ signal }): Promise<Project[]> =>
      client("/api/projects", "projects", {
        signal,
        fallback: "Couldn't load your projects.",
      }),
  });
}