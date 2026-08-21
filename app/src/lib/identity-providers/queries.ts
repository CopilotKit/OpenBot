import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

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
};

export const identityProviderKeys = {
  all: ["identity-providers"] as const,
  list: () => ["identity-providers", "list"] as const,
};

/**
 * The registered providers.
 *
 * Read from Better Auth's own route rather than one of ours, because the plugin owns the table and a
 * second reader would be a second answer. The payload carries no client secret or signing key: the
 * fields below are all this asks for.
 */
export function identityProviderListQueryOptions() {
  return queryOptions({
    queryKey: identityProviderKeys.list(),
    queryFn: async (): Promise<IdentityProvider[]> => {
      // `{ providers: [...] }`, not a bare array. Better Auth's own routes carry their own
      // envelope, which is why this reads the body rather than passing a key to `client`.
      const response = await client("/api/auth/sso/providers", {
        fallback: "Could not load identity providers",
      });
      const { providers = [] } = (await response.json()) as {
        providers?: {
          providerId: string;
          issuer: string;
          domain: string;
          samlConfig?: unknown;
        }[];
      };

      return providers.map((provider) => ({
        providerId: provider.providerId,
        issuer: provider.issuer,
        domain: provider.domain,
        protocol: provider.samlConfig ? "saml" : "oidc",
      }));
    },
  });
}
