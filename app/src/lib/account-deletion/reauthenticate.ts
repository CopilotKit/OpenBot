import type { QueryClient } from "@tanstack/react-query";
import { getDeployment } from "@/lib/api/generated/organization-settings/organization-settings";
import { DEPLOYMENT_ORGANIZATION } from "@/lib/api/request";
import { authClient, providerName } from "@/lib/auth/client";
import { connectedThroughDesktop } from "@/lib/auth/mutations";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
} from "@/lib/auth/queries";

/**
 * SIGNING IN AGAIN, WITHOUT SIGNING OUT, to do something that needs a recent sign-in (deleting the
 * account: the API answers REAUTHENTICATE to a sign-in older than ten minutes).
 *
 * Signing out first sent the person through their company's sign-out too (OpenID Connect
 * RP-Initiated Logout), whose page stops at "You are logged out" unless an admin has registered an
 * address to come back to. So instead this starts a new sign-in at the provider they signed in
 * with, asking it to make them sign in again even though it remembers them: OpenID Connect Core 1.0
 * section 3.1.2.1, `prompt=login` ("SHOULD prompt the End-User for reauthentication") and
 * `max_age=0` (the time since they last actively signed in must be no more than 0 seconds, so the
 * provider must sign them in actively). Google takes no `prompt=login` and has its own
 * `select_account`, so Google is asked for that with `max_age=0`. The person's address is the
 * `login_hint`, so the provider offers the same account. They come back to General settings, where
 * the delete dialog opens again (pending.ts), with a new session: the sign-in the API counts.
 *
 * Sent as Better Auth's social sign-in `additionalParams`, the extra query parameters it puts on
 * the provider's authorization request (better-auth.com/docs/concepts/oauth).
 *
 * Where it can't (a hosted OpenBot, whose sign-in is OpenBot by CopilotKit's and comes back to the
 * sign-in screen by itself; OpenBot Desktop connected to another OpenBot; a person who signed in
 * some other way), it answers false and the caller signs out instead.
 */

/** What a provider is asked to make the person sign in again, by the provider. */
export function freshSignInParams(
  provider: AuthProviderId,
): Record<string, string> {
  return provider === "google"
    ? { prompt: "select_account", max_age: "0" }
    : { prompt: "login", max_age: "0" };
}

type Started = { error?: { message?: string } | null };

/** What the browser and Better Auth do, kept here so a test can stand in for them. */
export const reauthenticationDeps = {
  start: (input: {
    provider: string;
    callbackURL: string;
    loginHint: string;
    additionalParams: Record<string, string>;
  }): Promise<Started> =>
    authClient.signIn.social(input as never) as Promise<Started>,
  origin: () => window.location.origin,
  /**
   * What the sign-in screen offers, asked as nobody is: on the pending page every signed-in read but
   * the person's own is refused (ACCOUNT_PENDING_DELETION), and the sign-in screen's is anybody's.
   */
  signInOptionsAsNobody: async () => {
    const body = await getDeployment(DEPLOYMENT_ORGANIZATION, {
      credentials: "omit",
      fallback: "Couldn't start signing in again.",
    });
    return {
      providers: body.authProviders as AuthProviderId[],
      hosted: body.hostedSignIn === true,
    };
  },
};

/**
 * Send the person to sign in again at the provider they signed in with, and back to General
 * settings. Answers false, having done nothing, where there is no such provider to send them to.
 */
export async function signInAgainAtProvider(
  queryClient: QueryClient,
  person: { email: string; providers?: string[] },
): Promise<boolean> {
  if (await connectedThroughDesktop(queryClient)) return false;
  const options = await queryClient
    .ensureQueryData(authProvidersQueryOptions())
    .catch(() => reauthenticationDeps.signInOptionsAsNobody())
    .catch(() => undefined);
  if (!options || options.hosted) return false;
  const provider = options.providers.find((one) =>
    (person.providers ?? []).includes(one),
  );
  if (!provider) return false;
  const started = await reauthenticationDeps.start({
    provider,
    callbackURL: `${reauthenticationDeps.origin()}/settings`,
    loginHint: person.email,
    additionalParams: freshSignInParams(provider),
  });
  if (started.error)
    throw new Error(
      started.error.message ||
        `Couldn't start signing in again with ${providerName(provider)}.`,
    );
  return true;
}
