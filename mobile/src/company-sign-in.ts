/**
 * An organization that holds the person out until they sign in through their company (Require SSO), and the ways in it
 * offers: Link your company account, through a provider that counts for it. The server says which, even while it holds
 * them out (`getCompanySignIn`). It imports nothing that needs a phone, so it can be tested.
 */

export const LINK_COMPANY_ACCOUNT = "Link your company account";

/** What the phone says when the server's own sentence is not to hand. */
export const HELD_OUT =
  "This organization requires signing in through your company's identity provider.";

/** Whether the organization the person works in holds them out: it requires company sign-in, and they haven't. */
export function heldOut(
  signIn: { required: boolean; met: boolean } | undefined,
): boolean {
  return !!signIn && signIn.required && !signIn.met;
}

/**
 * A button for each provider the person can link through: one, Link your company account; several (a company mid-merger),
 * one each, by the email domain it signs in, since an id means nothing to the person.
 */
export function linkButtons(
  providers: { id: string; domain: string }[],
): { providerId: string; title: string }[] {
  return providers.map((provider) => ({
    providerId: provider.id,
    title:
      providers.length === 1
        ? LINK_COMPANY_ACCOUNT
        : `Link through ${provider.domain}`,
  }));
}
