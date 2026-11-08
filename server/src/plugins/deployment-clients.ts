import { askAdminTo, itsAppPage } from "../edition";

/**
 * The OAuth clients this deployment registered itself, for the brokered apps that need one.
 *
 * SERVER-TO-SERVER ONLY, AND THAT IS THE WHOLE OF THE SCOPE. `S2S_OAUTH2` is a client-credentials
 * grant: Composio exchanges the client id and secret for a token at connect time, with no consent
 * screen and no redirect, so the one thing the deployment has to hold is the pair itself. Shopify
 * publishes exactly this for a Dev Dashboard app installed on a store its organization owns. An
 * app's ordinary `OAUTH2` still needs a redirect this deployment does not run, and stays refused.
 *
 * READ FROM THE ENVIRONMENT, BECAUSE IT IS A SECRET OF WHOEVER RUNS THE DEPLOYMENT. Per app, as
 * `COMPOSIO_<SLUG>_CLIENT_ID` and `COMPOSIO_<SLUG>_CLIENT_SECRET` (`COMPOSIO_SHOPIFY_CLIENT_ID`).
 * Both or nothing: half a pair is no client, and an app offered on half a pair fails at enable.
 * There is still no screen for it, for the reason `docs/plugins/composio.md` gives.
 */
export type DeploymentClient = { client_id: string; client_secret: string };

export const DEPLOYMENT_CLIENT_SCHEME = "S2S_OAUTH2";

/** The two variable names for one app's client: the slug upper-cased, anything else an underscore. */
export function deploymentClientVariables(toolkit: string): {
  id: string;
  secret: string;
} {
  const prefix = `COMPOSIO_${toolkit.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_CLIENT_`;
  return { id: `${prefix}ID`, secret: `${prefix}SECRET` };
}

export function deploymentClientOf(
  toolkit: string,
  env: Record<string, string | undefined> = process.env,
): DeploymentClient | null {
  const names = deploymentClientVariables(toolkit);
  const id = env[names.id]?.trim();
  const secret = env[names.secret]?.trim();
  return id && secret ? { client_id: id, client_secret: secret } : null;
}

/**
 * Whether an app connected under this scheme may only hold the deployment's one shared account.
 *
 * A PERSONAL ACCOUNT ON THE DEPLOYMENT'S CLIENT WOULD BE THE ORGANIZATION'S ACCESS UNDER ONE
 * PERSON'S NAME. Somebody connecting a server-to-server app types only what the connection names,
 * a store subdomain, and the credential Composio exchanges is the client above, so whoever could
 * see the app enabled could hold the store's full access as "their own" account, granted by nobody
 * and attributed to them on the trail. So the account is a Shared one: an administrator connects
 * it once and grants it to Bots the usual way. Read by the connect route and the store before
 * anything is sent, and by the screens through `sharedOnly` on the listing.
 */
export function sharedAccountOnly(authScheme: string | null): boolean {
  return authScheme === DEPLOYMENT_CLIENT_SCHEME;
}

/** The refusal a personal connect to such an app meets, in one place for both readers of it. */
export function sharedAccountOnlySentence(title: string): string {
  return `${title} connects only as one shared account, because it signs in with this deployment's own client rather than anything of yours, so no account was made. ${askAdminTo(`make it shared on ${itsAppPage()} and connect it there`)}.`;
}
