import { queryOptions } from "@tanstack/react-query";
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
  list: () => ["people", "list"] as const,
};

export function peopleListQueryOptions() {
  return queryOptions({
    queryKey: peopleKeys.list(),
    queryFn: (): Promise<Person[]> =>
      client("/api/admin/people", "people", {
        fallback: "Could not load people",
      }),
  });
}
