import { useQueries, useQuery } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { useUserPreferences } from "@/lib/settings/message-list";
import { type MovedElsewhere, movedElsewhere } from "./moved-elsewhere";
import { importListInQueryOptions, importListQueryOptions } from "./queries";

/**
 * Where the person's moved Bots are, when it is another of their organizations than the one they
 * work in (`movedElsewhere`), or null.
 *
 * Asked only of a hosted OpenBot, the one moves go to, and only of a person with another
 * organization to look in. Every one of their organizations is asked, the one they work in too: a
 * finished move here says nothing on its own, because their Bots may since have moved on from here
 * to another of their organizations. Null until every read it needs has answered, and on any read
 * that failed: the bar is a pointer, never a second place to report an error.
 */
export function useMovedElsewhere(): MovedElsewhere | null {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const choices = useOrganizationChoices();
  const takesMoves = capabilities.data?.hostedSignIn === true;
  const others =
    takesMoves && choices
      ? choices.organizations.filter((one) => one.id !== choices.currentId)
      : [];
  const here = useQuery({
    ...importListQueryOptions(),
    enabled: others.length > 0,
  });
  const elsewhere = useQueries({
    queries: others.map((organization) =>
      importListInQueryOptions(organization.id),
    ),
  });
  const preferences = useUserPreferences();
  if (!choices || !here.isSuccess || !preferences.isSuccess) return null;
  if (elsewhere.some((read) => !read.isSuccess)) return null;
  const imports = new Map(
    others.map((organization, at) => [
      organization.id,
      elsewhere[at]?.data ?? [],
    ]),
  );
  imports.set(choices.currentId, here.data);
  return movedElsewhere(
    choices.currentId,
    choices.organizations,
    imports,
    preferences.data.dismissedNotices ?? [],
  );
}
