import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { ownOrganizationsQueryOptions } from "./queries";

/**
 * A `beforeLoad` for a page about the person's organizations and invitations. Where OpenBot lists
 * no organizations (the personal edition among them) there is nothing for it to show, so the person
 * goes home.
 */
export async function organizationsOnly({
  context,
}: {
  context: { queryClient: QueryClient };
}) {
  const mine = await context.queryClient.ensureQueryData(
    ownOrganizationsQueryOptions(),
  );
  if (!mine || mine.organizations.length === 0) throw redirect({ to: "/" });
}
