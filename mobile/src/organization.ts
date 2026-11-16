/**
 * The organization the signed-in person is working in, read once per sign-in.
 *
 * A person can belong to several organizations. Which one they are working in is the server's
 * answer: the active one in the list of their own. This holds that answer for whoever is signed in,
 * so every request the API addresses by organization goes to it, and asks again when somebody else
 * signs in. It imports nothing, so it can be tested without a phone.
 */

export type ListedOrganization = { id: string; active?: boolean };

/** What somebody in no organization is told. */
export const IN_NO_ORGANIZATION =
  "You aren't a member of an organization here. Ask an admin to add you.";

/** The path every address under an organization starts with, before the organization is filled in. */
export const ORGANIZATION = "/api/v2/organizations/{organizationId}";

/** The one the person is working in: the active one, else the one they joined first. */
export function workingIn(organizations: ListedOrganization[]): string {
  const found = organizations.find((one) => one.active) ?? organizations[0];
  if (!found) throw new Error(IN_NO_ORGANIZATION);
  return found.id;
}

/**
 * Fills the organization into a path that starts with {@link ORGANIZATION}; any other path is
 * returned as it is. `list` reads the person's organizations, and is asked once for each sign-in
 * (`signedInAs` is whatever tells one sign-in from another). A read that fails is asked again.
 */
export function createOrganizationAddress(
  list: () => Promise<ListedOrganization[]>,
) {
  let known: { signedInAs: string; id: Promise<string> } | undefined;
  return async (path: string, signedInAs: string): Promise<string> => {
    if (!path.startsWith(ORGANIZATION)) return path;
    if (known?.signedInAs !== signedInAs) {
      const id = list().then(workingIn);
      known = { signedInAs, id };
      id.catch(() => {
        if (known?.id === id) known = undefined;
      });
    }
    const id = await (known as { id: Promise<string> }).id;
    return `/api/v2/organizations/${encodeURIComponent(id)}${path.slice(ORGANIZATION.length)}`;
  };
}
