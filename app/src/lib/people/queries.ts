import { infiniteQueryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Somebody who has signed in to this deployment.
 *
 * People are here because they signed in, not because they were invited: the identity provider
 * decides who exists, and this screen decides what they may do once they are here.
 */
export type Person = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: "admin" | "user";
  /** The providers they have arrived through. More than one is normal mid-migration. */
  providers: string[];
  lastSignedInAt: string | null;
  /** Whether an administrator has removed them. They keep their row and their history. */
  revoked: boolean;
  /**
   * Whether the deployment's configuration fixes their role.
   *
   * The server's verdict, rendered rather than recomputed here: this screen does not know what is in
   * `INITIAL_ADMIN_EMAILS` and should not try to work it out from anything else.
   */
  configuredAdmin: boolean;
};

export const peopleKeys = {
  all: ["people"] as const,
  list: (search = "") => ["people", "list", { search }] as const,
};

/** One page of people, and where the next one starts. */
export type PeoplePage = {
  people: Person[];
  nextCursor: string | null;
};

/**
 * The people in this deployment, a page at a time.
 *
 * Paged because this list grows with the company. It used to fetch everybody on every render of the
 * screen, joined to their roles, accounts and sessions.
 *
 * The search goes to the server rather than filtering what arrived, for the same reason: the point
 * is to find somebody who is not on the first page.
 */
export function peopleListQueryOptions(search = "") {
  return infiniteQueryOptions({
    queryKey: peopleKeys.list(search),
    initialPageParam: "",
    queryFn: ({ pageParam }): Promise<PeoplePage> => {
      const query = new URLSearchParams();
      if (search) query.set("search", search);
      if (pageParam) query.set("cursor", pageParam as string);
      const suffix = query.size > 0 ? `?${query}` : "";

      return client(`/api/admin/people${suffix}`, {
        fallback: "Could not load people",
      }).then((response) => response.json() as Promise<PeoplePage>);
    },
    getNextPageParam: (page: PeoplePage) => page.nextCursor ?? undefined,
  });
}
