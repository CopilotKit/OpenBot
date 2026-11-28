/**
 * Whose identity providers the Identity providers page is about. In `default` they are the deployment's, counted for
 * everybody who signs in to OpenBot. In any other organization they are that organization's own: its admins register
 * them, and they sign in its members (GitHub style).
 *
 * `hosted` is a hosted OpenBot (`hostedSignIn`), where the other way in is the person's OpenBot by CopilotKit account,
 * not Google, Microsoft or Okta, and nothing about sign-in is set in an environment an admin holds.
 */
export function identityProviderWords(
  organizationOnly: boolean,
  hosted = false,
) {
  const words = organizationOnly
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
  if (!hosted)
    return {
      ...words,
      registeredDescription:
        "Google, Microsoft and Okta are set in the environment. They don't show here.",
      signInDescription:
        "Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Activity.",
      scimOff:
        "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory.",
    };
  return {
    ...words,
    ssoOff: organizationOnly
      ? "Members can also sign in with their OpenBot by CopilotKit account."
      : "People can also sign in with their OpenBot by CopilotKit account.",
    registeredDescription:
      "Signing in with an OpenBot by CopilotKit account is built in, so it doesn't show here.",
    signInDescription:
      "While Require SSO is on, admins sign in through an identity provider too.",
    scimOff: "Off. Directory provisioning isn't available here.",
  };
}
