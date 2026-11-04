/**
 * The identity providers this deployment has registered, as facts about the deployment.
 *
 * Better Auth's SSO plugin owns the table and the registration route, and both are right: parsing a
 * company's OIDC discovery document or SAML metadata is work worth not repeating. What it also does
 * is stamp the registering person's id on the row and then answer `GET /sso/providers` with
 * `providers.filter(p => p.userId === session.user.id)`, and refuse a delete unless the same person
 * asks. That is the correct model for a personal integration and the wrong one for this: a company's
 * Okta tenant is not the property of whichever administrator happened to paste the metadata in.
 *
 * Two things went wrong from it. A second administrator opening the Identity providers screen saw an
 * empty list and re-registered a provider that was already there, and the person who set it up
 * leaving the company took the company's sign-in with them, because the row cascaded from their user
 * row. So reads and removals come through here, against the whole table, and the column that used to
 * decide existence is now only a record of who registered it.
 *
 * Registration still goes to Better Auth. This never writes a provider, so there is one parser for
 * metadata and one place a client secret is stored.
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { ssoProviders } from "../db/schema";
import { idempotencyKey } from "../people/directory/client";
import { people } from "../people/directory/directory";

/**
 * A registered provider, as an administrator screen may see it.
 *
 * Deliberately not the row. `oidcConfig` and `samlConfig` carry a client secret and a signing
 * certificate, and no projection that includes them can be safe to send to a browser, so the shape
 * that leaves this module cannot express them.
 */
export type RegisteredIdentityProvider = {
  providerId: string;
  issuer: string;
  /** The email domain that routes somebody here. */
  domain: string;
  /** Which protocol it speaks. SAML is what most enterprise identity teams hand over. */
  protocol: "saml" | "oidc";
  /** Whether the person who registered it still has an account here. Null once they are gone. */
  registeredBy: string | null;
};

export type IdentityProviderStore = {
  /** Every provider this deployment holds, whoever registered it. */
  list: () => Promise<RegisteredIdentityProvider[]>;
  /**
   * Forget one. Answers whether there was one to forget, so a caller can tell a stale screen from a
   * failure rather than reporting both as success.
   */
  remove: (providerId: string) => Promise<boolean>;
};

export function createIdentityProviderStore(
  database: Database,
): IdentityProviderStore {
  return {
    /*
     * From Intelligence's directory, which holds what describes each provider for the whole
     * organization. A provider registered here whose description has not reached the directory yet
     * (its write after registration failed) is described to it now, so the screen and the directory
     * never disagree for long.
     */
    list: async () => {
      const directory = people();
      const rows = await database
        .select({
          providerId: ssoProviders.providerId,
          issuer: ssoProviders.issuer,
          domain: ssoProviders.domain,
          samlConfig: ssoProviders.samlConfig,
          userId: ssoProviders.userId,
        })
        .from(ssoProviders);
      let held = await directory.client.allIdentityProviders();
      const known = new Set(held.map((provider) => provider.providerId));
      const missing = rows.filter((row) => !known.has(row.providerId));
      for (const row of missing)
        await directory.client.putIdentityProvider(
          {
            providerId: row.providerId,
            issuer: row.issuer,
            domain: row.domain.toLowerCase(),
            protocol: row.samlConfig ? "saml" : "oidc",
            registeredBy: row.userId,
          },
          idempotencyKey("describe-identity-provider"),
        );
      if (missing.length > 0)
        held = await directory.client.allIdentityProviders();

      // Only providers this deployment can sign people in with: one whose secret is here.
      const local = new Set(rows.map((row) => row.providerId));
      return held
        .filter((provider) => local.has(provider.providerId))
        .sort((a, b) => a.domain.localeCompare(b.domain))
        .map((provider) => ({
          providerId: provider.providerId,
          issuer: provider.issuer,
          domain: provider.domain,
          protocol: provider.protocol,
          registeredBy: provider.registeredBy,
        }));
    },

    /*
     * The directory first, then the row holding the secret: a provider the directory no longer
     * describes but whose secret is still here is put back in the directory by the next listing,
     * never left signing people in unseen.
     */
    remove: async (providerId) => {
      const described = await people().client.deleteIdentityProvider(
        providerId,
        idempotencyKey("remove-identity-provider"),
      );
      const removed = await database
        .delete(ssoProviders)
        .where(eq(ssoProviders.providerId, providerId))
        .returning({ providerId: ssoProviders.providerId });

      return removed.length > 0 || described;
    },
  };
}
