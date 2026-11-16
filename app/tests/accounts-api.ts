/**
 * The accounts API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads and changes the signed-in person through the client generated from api/openapi.yaml,
 * at `/api/v2/organizations/default/people/me`: the person comes back as `{ person, openbotVersion }`,
 * their preferences and standing instructions as themselves, and a change of name as `{ person }`.
 * A test written against the person as `/api/me` answered them (`{ user, version }`) passes that
 * here and gets the API's answer.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
/** The signed-in person: the API's `people/me`. */
export const ME_PATH = `${ORGANIZATION}/people/me`;
export const PREFERENCES_PATH = `${ME_PATH}/preferences`;
export const INSTRUCTIONS_PATH = `${ME_PATH}/instructions`;
export const ONBOARDING_ADVANCE_PATH = `${ME_PATH}/onboarding/advance`;
export const ONBOARDING_COMPLETE_PATH = `${ME_PATH}/onboarding/complete`;
export const LINKED_ACCOUNTS_PATH = `${ME_PATH}/linked-accounts`;
export const LINKED_ACCOUNT_PROVIDERS_PATH = `${ORGANIZATION}/linked-account-providers`;
export const PEOPLE_PATH = `${ORGANIZATION}/people`;
export const IDENTITY_PROVIDERS_PATH = `${ORGANIZATION}/identity-providers`;

/** The person as `/api/me` described them, which a test may give in part. */
export type TodayUser = {
  id: string;
  email?: string;
  name?: string | null;
  needsName?: boolean;
  image?: string | null;
  /** Today's `user` is the API's `member`. */
  role?: "owner" | "admin" | "member" | "user";
  onboarding?: { step: number; completedAt: string | null } | null;
};

/** A person in the API's shape, with what `/api/me` never said filled in. */
export function personBody(user: TodayUser) {
  return {
    id: user.id,
    email: user.email ?? `${user.id}@example.com`,
    name: user.name ?? null,
    image: user.image ?? null,
    role: !user.role || user.role === "user" ? "member" : user.role,
    needsName: user.needsName ?? false,
    onboarding: user.onboarding ?? null,
    providers: [],
    lastSignedInAt: null,
    revoked: false,
    configuredAdmin: false,
  };
}

/** The API's answer to `people/me`, from what `/api/me` would have answered. */
export function meBody(today: { user: TodayUser; version?: string | null }) {
  return {
    person: personBody(today.user),
    openbotVersion: today.version ?? null,
  };
}

/** The same, as a Response. */
export function meResponse(today: {
  user: TodayUser;
  version?: string | null;
}): Response {
  return NativeResponse.json(meBody(today));
}

/** The API's answer for preferences: the preferences themselves, not wrapped. */
export function preferencesResponse(today: { preferences: unknown }): Response {
  return NativeResponse.json(today.preferences);
}

/** The API's 401 for somebody signed out, as problem details. */
export function signedOutResponse(): Response {
  return NativeResponse.json(
    {
      type: "https://open.bot/errors/auth-unauthenticated",
      title: "Authentication is required.",
      status: 401,
      detail: "Authentication required.",
      code: "AUTH_UNAUTHENTICATED",
      category: "auth",
      retryable: false,
      requestId: "req_test",
      traceId: "trace_test",
    },
    { status: 401, headers: { "content-type": "application/problem+json" } },
  );
}
