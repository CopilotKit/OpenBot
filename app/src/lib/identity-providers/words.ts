/**
 * Whose identity providers the Identity providers page is about. In `default` they are the deployment's, counted for
 * everybody who signs in to OpenBot. In any other organization they are that organization's own: its admins register
 * them, and they sign in its members (GitHub style).
 */
export function identityProviderWords(organizationOnly: boolean) {
  return organizationOnly
    ? {
        description:
          "Configure your company’s SAML or OpenID Connect provider for this organization’s members. Email domains determine which provider people use to sign in.",
        domainHelp:
          "Members with an address at this domain sign in through it. Separate several with commas.",
        ssoOn:
          "This organization’s members can only sign in through one of its identity providers.",
        ssoOff: "Members can also sign in with Google, Microsoft or Okta.",
      }
    : {
        description:
          "Configure your company’s SAML or OpenID Connect provider. Email domains determine which provider people use to sign in.",
        domainHelp:
          "Anybody with an address at this domain signs in here. Separate several with commas.",
        ssoOn:
          "People can only sign in through a registered SAML or OpenID Connect provider.",
        ssoOff: "People can also sign in with Google, Microsoft or Okta.",
      };
}
