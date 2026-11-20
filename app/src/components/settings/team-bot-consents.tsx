import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { clearTeamBotConsentsMutationOptions } from "@/lib/team-bots";

/**
 * A Bot someone shared with you uses its owner's connected apps unless you let it use yours on the
 * card it shows you. This forgets every one of those answers, so each such Bot asks again.
 *
 * On Approvals rather than Connections because it is an answer to "may this Bot use my apps",
 * which is the question every other row on Approvals answers, not a connection of its own.
 */
export function TeamBotConsents() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  if (personal) return null;
  return (
    <PageSection
      description="A Bot shared with you uses its owner's apps. It uses yours only where you said yes in a conversation."
      title="Shared Bots"
    >
      {clear.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {clear.error.message}
        </p>
      ) : null}
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>Apps you let shared Bots use</ItemTitle>
            <ItemDescription>
              {clear.isSuccess
                ? "Reset. Each shared Bot will ask again."
                : "Forget every answer, so each shared Bot asks again."}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
              size="sm"
              variant="outline"
            >
              Reset
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
