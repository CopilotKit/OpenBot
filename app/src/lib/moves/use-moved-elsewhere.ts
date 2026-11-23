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
 * organization to look in. Their other organizations are asked only once the one they work in has
 * answered that it holds none of their moves, so somebody working where their Bots are asks nothing
 * more. Null until every read it needs has answered, and on any read that failed: the bar is a
 * pointer, never a second place to report an error.
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
  const noneHere =
    here.isSuccess && !here.data.some((move) => move.status === "imported");
  const elsewhere = useQueries({
    queries: others.map((organization) => ({
      ...importListInQueryOptions(organization.id),
      enabled: noneHere,
    })),
  });
  const preferences = useUserPreferences();
  if (!choices || !noneHere || !preferences.isSuccess) return null;
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
