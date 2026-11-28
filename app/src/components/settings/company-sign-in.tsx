import { IconBuildingBank } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { LinkCompanyAccount } from "@/components/auth/link-company-account";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import type { CompanySignIn } from "@/lib/api/generated/model";
import { companySignInQueryOptions } from "@/lib/auth/company-sign-in";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/** The row's second line: whether the person's company account is linked, and whether this organization requires it. */
export function companySignInLine(
  signIn: Pick<CompanySignIn, "required" | "met">,
): string {
  if (signIn.met)
    return "Linked. You sign in to this organization through your company.";
  return signIn.required
    ? "This organization requires it. Link it to keep working here."
    : "Link it to sign in to this organization through your company.";
}

/**
 * Settings, General: the person's company account, where their organization has identity providers. Linked, it says
 * so. Not linked, it offers Link your company account under the row: one button for one provider, a button each for
 * several. Nothing where the organization has none, or where the server has no answer for it. Nothing on OpenBot by
 * CopilotKit (`hostedSignIn`), where people sign in with their CopilotKit account and no organization has a company
 * sign-in of its own.
 */
export function CompanySignInSection() {
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  const signIn = useQuery({
    ...companySignInQueryOptions(),
    enabled: !hosted,
  }).data;
  if (hosted || !signIn || signIn.providers.length === 0) return null;
  return (
    <PageSection title="Company sign-in">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconBuildingBank />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Company account</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {companySignInLine(signIn)}
            </ItemDescription>
          </ItemContent>
          {signIn.met ? (
            <ItemActions>
              <span className="text-muted-foreground text-sm">Linked</span>
            </ItemActions>
          ) : (
            // On a line of its own under the row: the button's words are long, and beside them the row's own
            // sentence was squeezed to a word a line in a narrow window.
            // In line with the row's words, past the icon's tile and the gap after it.
            <ItemFooter className="pl-11">
              <LinkCompanyAccount
                className="flex-row flex-wrap"
                providers={signIn.providers}
                size="sm"
              />
            </ItemFooter>
          )}
        </Item>
      </PageRows>
    </PageSection>
  );
}
