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
import { ControlsSection } from "./controls-section";

/** Admin, Identity providers: whether SSO is the only way in, and directory provisioning. */
export function SignInSection() {
  return (
    <ControlsSection
      description="Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Audit."
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
                  ? `Directory base URL ${data.scim.baseUrl ?? "(set BETTER_AUTH_URL)"} with the SCIM_BEARER_TOKEN bearer token. Deprovisioning ends sessions, blocks the address, retires connector credentials and stops their computers.`
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
