import { queryOptions } from "@tanstack/react-query";
import type { GetPersonResponse } from "@/lib/api/generated/model";
import { getPerson } from "@/lib/api/generated/people/people";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError, client } from "@/lib/client";

/**
 * Where this person is in first-run onboarding.
 *
 * On the user rather than its own query, so the `_authed` gate learns it from the request it
 * already makes. A null `completedAt` is what sends the app to /onboarding.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  needsName?: boolean;
  image?: string | null;
  role: "admin" | "user";
  /** Null means this deployment does not track onboarding, which reads as nothing to finish. */
  onboarding: OnboardingStatus | null;
  /**
   * The OpenBot release the server runs, such as "v0.3.1", drawn small under this person's name.
   * Not the person's: the API answers it beside them (getPerson's `openbotVersion`), and it rides here
   * so the request the `_authed` gate already makes brings it. Null when the server was built without
   * one.
   */
  openbotVersion?: string | null;
};

/** Whether the gate holds: there is an onboarding to do and this person has not finished it. */
export function needsOnboarding(user: AuthenticatedUser): boolean {
  return user.onboarding !== null && user.onboarding.completedAt === null;
}

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/** An identity provider this deployment can sign somebody in with. */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
  /**
   * Whether any enterprise identity provider is registered.
   *
   * A boolean, not a list: naming them would tell anybody who loads the sign-in page which companies
   * use this deployment, before they have signed in.
   */
  sso: boolean;
  /** An administrator requires SSO; social sign-in stays only as the administrators' break-glass. */
  ssoRequired: boolean;
};

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallback: "Could not load sign-in" })
  ).json()) as {
    authProviders?: AuthProviderId[];
    ssoConfigured?: boolean;
    ssoRequired?: boolean;
  };

  return {
    providers: body.authProviders ?? [],
    sso: body.ssoConfigured === true,
    ssoRequired: body.ssoRequired === true,
  };
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser(
  signal?: AbortSignal,
): Promise<AuthenticatedUser | null> {
  /*
   * Not being signed in is an answer here, not a failure: the API refuses with 401, and the `_authed`
   * gate reads null as "go and sign in". Any other refusal is a failed request.
   */
  let answer: GetPersonResponse;
  try {
    answer = await getPerson(ORGANIZATION_ID, "me", {
      ...(signal ? { signal } : {}),
      fallback: "Could not load the current user",
    });
  } catch (error) {
    if (error instanceof ClientError && error.status === 401) return null;
    throw error;
  }
  const { person } = answer;
  return {
    id: person.id,
    email: person.email,
    name: person.name,
    needsName: person.needsName,
    image: person.image,
    role: person.role,
    onboarding: person.onboarding,
    openbotVersion: answer.openbotVersion,
  };
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: ({ signal }) => currentUser(signal),
    staleTime: 60_000,
  });
}
