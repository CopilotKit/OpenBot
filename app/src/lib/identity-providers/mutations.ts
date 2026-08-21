import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { identityProviderKeys } from "./queries";

const FALLBACK = "Could not change that identity provider";

function invalidateProviders(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: identityProviderKeys.all });
}

/**
 * What an administrator has to supply to register an identity provider.
 *
 * SAML wants the metadata XML their identity team gives them, which carries the entry point and the
 * signing certificate. OIDC wants an issuer and a client, because there is no equivalent document to
 * paste. Both want the domain, since that is what routes somebody to this provider rather than
 * another.
 */
export type IdentityProviderInput =
  | {
      protocol: "saml";
      providerId: string;
      domain: string;
      issuer: string;
      entryPoint: string;
      metadata: string;
    }
  | {
      protocol: "oidc";
      providerId: string;
      domain: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
    };

/** The body Better Auth's own route expects, which is not the shape the form collects. */
function registerBody(input: IdentityProviderInput) {
  const common = {
    providerId: input.providerId,
    issuer: input.issuer,
    domain: input.domain,
  };

  if (input.protocol === "saml") {
    return {
      ...common,
      samlConfig: {
        entryPoint: input.entryPoint,
        idpMetadata: { metadata: input.metadata },
      },
    };
  }

  return {
    ...common,
    oidcConfig: {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      // Let the provider describe itself rather than asking somebody to type six endpoints.
      discoveryEndpoint: `${input.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    },
  };
}

export function registerIdentityProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (input: IdentityProviderInput): Promise<void> => {
      await client("/api/auth/sso/register", {
        method: "POST",
        body: registerBody(input),
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateProviders(queryClient),
  });
}

export function deleteIdentityProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (providerId: string): Promise<void> => {
      await client("/api/auth/sso/delete-provider", {
        method: "POST",
        body: { providerId },
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateProviders(queryClient),
  });
}
