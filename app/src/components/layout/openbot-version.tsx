import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cn } from "@/lib/utils";

/**
 * The OpenBot release the server runs, in tiny type: to the right of the person's name in the
 * default sidebar, and under it in the OpenDots skin. The server's own answer, so it names what is deployed rather than what this bundle was built from.
 * Nothing at all when the server has no version to give, as in development.
 *
 * Never cut short: a build names itself `main-20261113-9` or `internal-<commit>`, longer than a
 * release's `v1.0.2`, and half of it says nothing. Where room runs out, the name beside it gives way.
 */
export function OpenBotVersion({ className }: { className?: string }) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const version = user?.openbotVersion;
  if (!version) return null;
  return (
    <span
      className={cn("block whitespace-nowrap tabular-nums", className)}
      data-slot="openbot-version"
    >
      {/^\d/.test(version) ? `v${version}` : version}
    </span>
  );
}
