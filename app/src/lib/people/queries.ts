import { infiniteQueryOptions } from "@tanstack/react-query";
import { listPeople } from "@/lib/api/generated/people/people";
import { organizationId } from "@/lib/api/request";
import { knownRole } from "@/lib/auth/roles";

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
  /** Their role as a member of the organization. Nobody is an owner yet. */
  role: "owner" | "admin" | "member";
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

/**
 * A person as the API answers them, in the shape this screen reads. A role a newer server names that
 * this app doesn't know is read as the least it could be, a member.
 */
export function personOf(
  person: Omit<Person, "role"> & { role: string },
): Person {
  return { ...person, role: knownRole(person.role) };
}

/** The most a search of a list of people, invitations or teams may hold: the API's cap. */
export const SEARCH_MAX = 200;

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
    queryFn: async ({ pageParam, signal }): Promise<PeoplePage> => {
      const page = await listPeople(
        organizationId(),
        {
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam as string } : {}),
        },
        { signal, fallback: "Could not load people" },
      );
      return {
        people: page.people.map(personOf),
        nextCursor: page.nextCursor,
      };
    },
    getNextPageParam: (page: PeoplePage) => page.nextCursor ?? undefined,
  });
}
