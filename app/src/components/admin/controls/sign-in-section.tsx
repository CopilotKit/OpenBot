import { IconFingerprint, IconShieldLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { identityProviderWords } from "@/lib/identity-providers/words";
import { useOrganizationChoices } from "@/lib/organizations/queries";
import { ControlsSection } from "./controls-section";

/**
 * What the directory deactivating somebody does. Where everybody has an organization of their own
 * and may create others (`canCreate`, the server's verdict), it ends their membership of this
 * organization alone; where OpenBot keeps one, it ends their access to OpenBot.
 */
function deprovisioning(severalOrganizations: boolean): string {
  return severalOrganizations
    ? "Deprovisioning removes the person from this organization, retires the connector credentials they granted here and stops their computers. They keep their own organization and any other."
    : "Deprovisioning ends sessions, blocks the address, retires connector credentials and stops their computers.";
}

/**
 * Admin, Identity providers: whether SSO is the only way in, and directory provisioning. `organizationOnly` outside
 * `default`, where requiring SSO is this organization's rule about its members.
 */
export function SignInSection({
  organizationOnly = false,
}: {
  organizationOnly?: boolean;
}) {
  const severalOrganizations = useOrganizationChoices()?.canCreate === true;
  // A hosted OpenBot: no social sign-in, and nothing here is set in an environment its admin holds.
  const hosted =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.hostedSignIn === true;
  const words = identityProviderWords(organizationOnly, hosted);
  return (
    <ControlsSection description={words.signInDescription} title="Sign-in">
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Require SSO</ItemTitle>
              <ItemDescription>
                {data.settings.ssoRequired ? words.ssoOn : words.ssoOff}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Require SSO"
                checked={data.settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) =>
                  setSetting("ssoRequired", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>SCIM provisioning</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? `Directory base URL ${data.scim.baseUrl ?? "(set BETTER_AUTH_URL)"} with the SCIM_BEARER_TOKEN bearer token. ${deprovisioning(severalOrganizations)}`
                  : words.scimOff}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured ? "On" : "Off"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </ControlsSection>
  );
}
