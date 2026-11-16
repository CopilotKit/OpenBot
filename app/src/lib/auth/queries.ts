import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { GetPersonResponse } from "@/lib/api/generated/model";
import { getPerson } from "@/lib/api/generated/people/people";
import { ClientError } from "@/lib/client";
import { readDeployment } from "@/lib/deployment/queries";
import { currentOrganizationId } from "@/lib/organizations/current";
import { ensureCurrentOrganization } from "@/lib/organizations/queries";

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
  /**
   * Their role as a member of the organization they are working in. An owner governs it as an admin
   * does: ask `isOrganizationAdmin` (lib/auth/roles.ts), never the role's name.
   */
  role: "owner" | "admin" | "member";
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
  // The API's `deployment`, which answers before anybody has signed in, and after in their own.
  const body = await readDeployment({ fallback: "Could not load sign-in" });
  return {
    providers: body.authProviders,
    sso: body.ssoConfigured,
    ssoRequired: body.ssoRequired,
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
  queryClient: QueryClient,
  signal?: AbortSignal,
): Promise<AuthenticatedUser | null> {
  /*
   * A person is read as a member of the organization they are working in, so that comes first: from
   * the list of their own when it is not known yet. Nobody signed in has none. Known already, the
   * person is asked for at once, as they always were.
   */
  const organizationId =
    currentOrganizationId() ?? (await ensureCurrentOrganization(queryClient));
  if (organizationId === undefined) return null;
  /*
   * Not being signed in is an answer here, not a failure: the API refuses with 401, and the `_authed`
   * gate reads null as "go and sign in". Any other refusal is a failed request.
   */
  let answer: GetPersonResponse;
  try {
    answer = await getPerson(organizationId, "me", {
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

/**
 * What OpenBot on one computer answers a request that does not come from its app. The personal
 * edition only admits requests carrying its install's token, which only its app has, so a browser
 * opened at the same address is refused this, word for word, on every request.
 */
export const ONLY_ITS_OWN_APP =
  "This OpenBot only answers its own app. Open it from the OpenBot app, or use an API key.";

/**
 * Whether a refusal is that one: a 403 with that sentence. Never the status alone, which every
 * other refusal by permission shares.
 */
export function refusedForNotBeingItsApp(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 403 &&
    error.message === ONLY_ITS_OWN_APP
  );
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: ({ client: queryClient, signal }) =>
      currentUser(queryClient, signal),
    staleTime: 60_000,
  });
}

/**
 * The signed-in person, for a route's gate: null when nobody is signed in.
 *
 * The organization they are working in is read first. Every cached answer is kept under its
 * organization (query-client.ts), so the person has to be asked for under the organization the
 * screens will read them under, and no screen behind the gate asks for anything before it is known.
 */
export async function signedInUser(
  queryClient: QueryClient,
): Promise<AuthenticatedUser | null> {
  if ((await ensureCurrentOrganization(queryClient)) === undefined) return null;
  return queryClient.ensureQueryData(currentUserQueryOptions());
}
