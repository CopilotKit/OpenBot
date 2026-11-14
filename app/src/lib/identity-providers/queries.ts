import { queryOptions } from "@tanstack/react-query";
import { listIdentityProviders } from "@/lib/api/generated/identity-providers/identity-providers";
import { ORGANIZATION_ID } from "@/lib/api/request";

/**
 * An identity provider a company registered, rather than one this deployment was configured with.
 *
 * The three in the environment are Google, Entra and Okta. These are somebody's own: registered
 * while the deployment is running, from metadata their identity team supplied, and there can be
 * several. A company mid-merger has two.
 */
export type IdentityProvider = {
  providerId: string;
  issuer: string;
  /** The email domain that routes somebody here. */
  domain: string;
  /** Which protocol it speaks. SAML is what most enterprise identity teams hand over. */
  protocol: "saml" | "oidc";
  /**
   * Whether the person who registered it still has an account here. Null once they are gone.
   *
   * Shown so somebody auditing a deployment can see that a provider outlived whoever set it up,
   * which is the normal case a year in and used to be the case where the provider vanished instead.
   */
  registeredBy: string | null;
};

export const identityProviderKeys = {
  all: ["identity-providers"] as const,
  list: () => ["identity-providers", "list"] as const,
};

/**
 * The registered providers.
 *
 * Read from the API's `identity-providers`, not Better Auth's `GET /sso/providers`. That one answers with the
 * providers the person asking registered themselves, so two administrators saw two different
 * deployments and the second one to open this screen found it empty and registered a provider that
 * already existed. What is registered is a fact about the deployment.
 *
 * The payload carries no client secret or signing certificate; the server's projection cannot express
 * them.
 */
export function identityProviderListQueryOptions() {
  return queryOptions({
    queryKey: identityProviderKeys.list(),
    queryFn: async ({ signal }): Promise<IdentityProvider[]> => {
      const providers: IdentityProvider[] = [];
      let cursor: string | undefined;
      // Every page: an organization registers a handful, and the screen lists them all.
      do {
        const page = await listIdentityProviders(
          ORGANIZATION_ID,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: "Could not load identity providers" },
        );
        providers.push(
          ...page.identityProviders.map(({ id, ...provider }) => ({
            providerId: id,
            ...provider,
          })),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return providers;
    },
  });
}
