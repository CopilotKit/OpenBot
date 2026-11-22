/*
 * A scene's session as API answers: what the `_authed` gates (app/src/routes/_authed.tsx) and the
 * organization list ask on the way to a route. A signed-in member who finished onboarding reaches
 * the route with no redirect; a signed-out person goes to the sign-in page, which reads the
 * deployment. Each body starts from the generated response mock.
 * Pattern: app/tests/accounts-api.ts (`personBody`).
 */
import type {
  Deployment,
  GetPersonResponse,
  OrganizationPage,
  PersonalAiConnection,
  ServiceTerms,
} from "@/lib/api/generated/model";
import { getGetPersonalAiConnectionResponseMock } from "@/lib/api/generated/models/models.msw";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { getGetPersonResponseMock } from "@/lib/api/generated/people/people.msw";
import type {
  ApiAnswer,
  ApiRoute,
  Role,
  Session,
} from "../../desktop/workbench/appContract";

export const SAM = { name: "Sam Rivera", email: "sam@example.com" } as const;

export const DEFAULT_SESSION: Session = {
  signedIn: true,
  role: "member",
  name: SAM.name,
  email: SAM.email,
  organization: { id: "default", name: "Acme" },
  onboarded: true,
};

/** The API routes the session answers. */
export const SESSION_ROUTES = {
  person: "GET /api/v2/organizations/:organizationId/people/me",
  organizations: "GET /api/v2/people/me/organizations",
  deployment: "GET /api/v2/organizations/:organizationId/deployment",
  terms: "GET /api/v2/organizations/:organizationId/people/me/terms",
  aiConnection:
    "GET /api/v2/organizations/:organizationId/people/me/ai-connection",
} as const satisfies Record<string, ApiRoute>;

const value = (body: unknown): ApiAnswer => ({ mode: "value", body });

/** A team install with the sign-in options most installs have: Google and Microsoft, no SSO. */
function deployment(): Deployment {
  return {
    ...getGetDeploymentResponseMock(),
    edition: "team",
    localEvaluation: false,
    authProviders: ["google", "microsoft"],
    ssoConfigured: false,
    ssoRequired: false,
    hostedSignIn: false,
  } satisfies Deployment;
}

/**
 * The answers for `session`. `role` (the Window panel's role) wins over the session's role.
 */
export function sessionApi(
  session: Session,
  role: Role | null = null,
): Partial<Record<ApiRoute, ApiAnswer>> {
  if (!session.signedIn) {
    return {
      [SESSION_ROUTES.person]: {
        mode: "fail",
        status: 401,
        body: { detail: "Sign in to continue." },
      },
      [SESSION_ROUTES.organizations]: {
        mode: "fail",
        status: 401,
        body: { detail: "Sign in to continue." },
      },
      [SESSION_ROUTES.deployment]: value(deployment()),
    };
  }
  const as = role ?? session.role;
  const mock = getGetPersonResponseMock();
  const person = {
    ...mock,
    person: {
      ...mock.person,
      id: "sam",
      name: session.name,
      email: session.email,
      role: as,
      needsName: false,
      // A null completedAt is what sends the app to /onboarding (needsOnboarding).
      onboarding: session.onboarded
        ? { step: 3, completedAt: "2026-11-05T10:02:47.000Z" }
        : { step: 0, completedAt: null },
    },
  } satisfies GetPersonResponse;
  const organizations = {
    organizations: [
      {
        id: session.organization.id,
        slug: session.organization.id,
        name: session.organization.name,
        role: as,
        active: true,
        personal: false,
      },
    ],
    canCreate: true,
    nextCursor: null,
  } satisfies OrganizationPage;
  const terms = {
    current: null,
    accepted: null,
    acceptanceNeeded: false,
  } satisfies ServiceTerms;
  const aiConnection = {
    ...getGetPersonalAiConnectionResponseMock(),
    uses: "organization",
    required: false,
  } satisfies PersonalAiConnection;
  return {
    [SESSION_ROUTES.person]: value(person),
    [SESSION_ROUTES.organizations]: value(organizations),
    [SESSION_ROUTES.deployment]: value(deployment()),
    [SESSION_ROUTES.terms]: value(terms),
    [SESSION_ROUTES.aiConnection]: value(aiConnection),
  };
}
