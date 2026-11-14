import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createIdentityProvider,
  deleteIdentityProvider,
} from "@/lib/api/generated/identity-providers/identity-providers";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
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

export function registerIdentityProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (input: IdentityProviderInput): Promise<void> => {
      const { providerId, ...rest } = input;
      await createIdentityProvider(
        ORGANIZATION_ID,
        { id: providerId, ...rest },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateProviders(queryClient),
  });
}

/**
 * Remove one.
 *
 * The API's, not Better Auth's `delete-provider`, which refuses unless the person asking is the
 * one who registered it. That left a provider nobody could remove the moment the administrator who
 * set it up had left, which is exactly when somebody needs to.
 */
export function deleteIdentityProviderMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (providerId: string): Promise<void> => {
      await deleteIdentityProvider(
        ORGANIZATION_ID,
        providerId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateProviders(queryClient),
  });
}
