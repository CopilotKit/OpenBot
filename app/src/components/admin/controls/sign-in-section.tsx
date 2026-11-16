import { IconFingerprint, IconShieldLock } from "@tabler/icons-react";
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

/** Admin, Identity providers: whether SSO is the only way in, and directory provisioning. */
export function SignInSection() {
  const severalOrganizations = useOrganizationChoices()?.canCreate === true;
  return (
    <ControlsSection
      description="Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Activity."
      title="Sign-in"
    >
      {({ data, setSetting, saving }) => (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Require SSO</ItemTitle>
              <ItemDescription>
                {data.settings.ssoRequired
                  ? "People can only sign in through a registered SAML or OpenID Connect provider."
                  : "People can also sign in with Google, Microsoft or Okta."}
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
                  : "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory."}
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
