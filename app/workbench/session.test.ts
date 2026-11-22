import { describe, expect, test } from "bun:test";
import {
  type ApiAnswer,
  isApiRoute,
  type Session,
} from "../../desktop/workbench/appContract";
import { DEFAULT_SESSION, SAM, SESSION_ROUTES, sessionApi } from "./session";

type Person = {
  person: {
    email: string;
    role: string;
    onboarding: { completedAt: string | null } | null;
  };
};

const SIGNED_IN = DEFAULT_SESSION as Extract<Session, { signedIn: true }>;

function body(answer: ApiAnswer | undefined): unknown {
  if (answer?.mode !== "value") throw new Error("expected a value answer");
  return answer.body;
}

describe("sessionApi", () => {
  test("signed in: people/me has the email and the role", () => {
    const api = sessionApi(DEFAULT_SESSION);
    const me = body(api[SESSION_ROUTES.person]) as Person;
    expect(me.person.email).toBe(SAM.email);
    expect(me.person.role).toBe("member");
    expect(me.person.onboarding?.completedAt).not.toBeNull();
  });

  test("the role argument wins over the session's role", () => {
    const api = sessionApi(DEFAULT_SESSION, "owner");
    const me = body(api[SESSION_ROUTES.person]) as Person;
    expect(me.person.role).toBe("owner");
  });

  test("onboarded false: onboarding is not finished", () => {
    const api = sessionApi({ ...SIGNED_IN, onboarded: false });
    const me = body(api[SESSION_ROUTES.person]) as Person;
    expect(me.person.onboarding).not.toBeNull();
    expect(me.person.onboarding?.completedAt).toBeNull();
  });

  test("signed in: no gate redirects", () => {
    const api = sessionApi(DEFAULT_SESSION);
    expect(body(api[SESSION_ROUTES.terms])).toMatchObject({
      acceptanceNeeded: false,
    });
    expect(body(api[SESSION_ROUTES.aiConnection])).toMatchObject({
      required: false,
    });
    expect(body(api[SESSION_ROUTES.organizations])).toMatchObject({
      organizations: [{ id: "default", name: "Acme", active: true }],
    });
    expect(body(api[SESSION_ROUTES.deployment])).toMatchObject({
      edition: "team",
    });
  });

  test("signed in: answers what a Desktop install shows, not random extras", () => {
    const api = sessionApi(DEFAULT_SESSION);
    // No trial bar: the plan is not required (app/src/lib/plan/queries.ts NOT_REQUIRED).
    expect(body(api[SESSION_ROUTES.plan])).toEqual({
      required: false,
      status: "not_required",
      trialEndsAt: null,
      renewsAt: null,
      addCardUrl: null,
    });
    // No "Company sign-in" section.
    expect(body(api[SESSION_ROUTES.companySignIn])).toEqual({
      required: false,
      met: true,
      providers: [],
    });
    // No "Your AI" section.
    expect(body(api[SESSION_ROUTES.aiConnection])).toMatchObject({
      available: false,
      signIns: [],
    });
  });

  test("signed out: no Desktop defaults, only the sign-in page's answers", () => {
    const api = sessionApi({ signedIn: false });
    expect(api[SESSION_ROUTES.plan]).toBeUndefined();
    expect(api[SESSION_ROUTES.companySignIn]).toBeUndefined();
  });

  test("signed out: people/me is a 401, and the deployment answers", () => {
    const api = sessionApi({ signedIn: false });
    expect(api[SESSION_ROUTES.person]).toEqual({
      mode: "fail",
      status: 401,
      body: { detail: "Sign in to continue." },
    });
    expect(api[SESSION_ROUTES.deployment]?.mode).toBe("value");
  });

  test("every key is an API route", () => {
    for (const session of [DEFAULT_SESSION, { signedIn: false } as const]) {
      for (const key of Object.keys(sessionApi(session))) {
        expect(isApiRoute(key)).toBe(true);
      }
    }
  });
});
