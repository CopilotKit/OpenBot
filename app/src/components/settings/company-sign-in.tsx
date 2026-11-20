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
 * so. Not linked, it offers Link your company account: one button for one provider, a button each, under the row, for
 * several. Nothing where the organization has none, or where the server has no answer for it.
 */
export function CompanySignInSection() {
  const signIn = useQuery(companySignInQueryOptions()).data;
  if (!signIn || signIn.providers.length === 0) return null;
  const several = signIn.providers.length > 1;
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
          ) : several ? (
            <ItemFooter>
              <LinkCompanyAccount
                className="flex-row flex-wrap"
                providers={signIn.providers}
                size="sm"
              />
            </ItemFooter>
          ) : (
            <ItemActions>
              <LinkCompanyAccount providers={signIn.providers} size="sm" />
            </ItemActions>
          )}
        </Item>
      </PageRows>
    </PageSection>
  );
}
