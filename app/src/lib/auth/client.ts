import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";
import type { AuthProviderId } from "./queries";

export const authClient = createAuthClient({ plugins: [ssoClient()] });

/** What each provider is called on the button, since none of them are called by their id. */
const PROVIDER_NAMES: Record<AuthProviderId, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
  oidc: "Grok",
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
/**
 * Pick up a Grok Build session that finished on loopback CORS, where the
 * browser would not store Better Auth's Set-Cookie on the consent fetch.
 */
export async function claimOidcSession(): Promise<boolean> {
  const response = await fetch("/api/auth/oidc-claim", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    return false;
  }
  const body = (await response.json()) as { claimed?: boolean };
  return body.claimed === true;
}

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

/**
 * Start sign-in through whichever identity provider covers this address.
 *
 * The email is not a credential here and no password is asked for: only the part after the @ is
 * used, to decide which registered provider to hand somebody to. A company with two IdPs mid-merger
 * has two domains, and this is how somebody reaches theirs without being asked which one they are.
 *
 * Injectable for the same reason as `signInWith`: the Better Auth client is a proxy.
 */
export async function signInWithEmailDomain(
  email: string,
  start: (input: {
    email: string;
    callbackURL: string;
  }) => Promise<SocialResult> = (input) =>
    (
      authClient as unknown as {
        signIn: { sso: (i: unknown) => Promise<SocialResult> };
      }
    ).signIn.sso(input),
) {
  const result = await start({ email, callbackURL: window.location.origin });

  if (result.error) {
    throw new Error(
      result.error.message ||
        "No identity provider is registered for that address.",
    );
  }
}
