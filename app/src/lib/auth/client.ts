import { createAuthClient } from "better-auth/react";
import type { AuthProviderId } from "./queries";

export const authClient = createAuthClient();

/** What each provider is called on the button, since none of them are called by their id. */
const PROVIDER_NAMES: Record<AuthProviderId, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

export function providerName(provider: AuthProviderId): string {
  return PROVIDER_NAMES[provider];
}

/** What a sign-in attempt came back with, which is either nothing or a reason. */
type SocialResult = { error?: { message?: string } | null };

/**
 * Start sign-in with one provider.
 *
 * One call for all three, including Okta. Okta is served by the generic OAuth plugin rather than as
 * a named provider, but the plugin registers under a provider id like any other, so the browser does
 * not need to know which kind it is asking for. Keeping that distinction on the server is the point:
 * a deployment can gain a provider without the app being rebuilt.
 *
 * `start` is injectable because Better Auth's client is a proxy, so a test cannot replace the method
 * on it. Named so it cannot shadow anything it defaults to.
 */
export async function signInWith(
  provider: AuthProviderId,
  start: (input: {
    provider: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    authClient.signIn.social(input as never) as Promise<SocialResult>,
) {
  const result = await start({
    provider,
    callbackURL: window.location.origin,
  });

  if (result.error) {
    // Naming the provider matters more with three buttons than it did with one: "Could not start
    // sign-in" leaves somebody looking at three of them with no idea which one refused.
    throw new Error(
      result.error.message ||
        `Could not start ${providerName(provider)} sign-in.`,
    );
  }
}
