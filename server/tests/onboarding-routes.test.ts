import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { OnboardingStore } from "../src/people/onboarding";
import { testEnvironment } from "./support/environment";

const MEMBER = {
  id: "member-1",
  email: "member@openbot.test",
  name: "A Member",
  image: null,
};

/**
 * The wizard's server half: /api/me carries where somebody is, and one POST moves them.
 *
 * The rules worth pinning are the shapes — what the app gates on has to keep meaning what it meant,
 * and a body the route does not understand has to be refused rather than written.
 */
function appWith(store?: OnboardingStore) {
  return createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: MEMBER }) },
    } as never,
    { rolesForUser: async () => ["user"] },
    /*
     * Positions 4-23 are the other stores; `store` is 24, onboardingStore, the signature's last.
     * Every parameter from 4 on is optional, so a wrong count is a silent type-check pass — see
     * people-routes.test.ts, which learned this the hard way.
     */
    ...(Array.from({ length: 20 }) as never[]),
    store as never,
  );
}

/** A store holding one person's status in memory, with the same coalesce rule the real one has. */
function memoryStore(initial: { step: number; completedAt: string | null }) {
  const state = { ...initial };
  const store: OnboardingStore = {
    status: async () => ({ ...state }),
    setStep: async (_userId, step) => {
      state.step = step;
    },
    complete: async () => {
      state.completedAt = state.completedAt ?? "2026-08-27T00:00:00.000Z";
    },
  };
  return { store, state };
}

describe("onboarding routes", () => {
  test("/api/me carries the person's onboarding status", async () => {
    const { store } = memoryStore({ step: 1, completedAt: null });
    const app = appWith(store);

    const response = await app.request("http://openbot.local/api/me");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { onboarding: { step: number; completedAt: string | null } };
    };
    expect(body.user.onboarding).toEqual({ step: 1, completedAt: null });
  });

  test("/api/me reports null onboarding when the deployment has no store", async () => {
    const app = appWith(undefined);

    const response = await app.request("http://openbot.local/api/me");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { onboarding: null } };
    expect(body.user.onboarding).toBeNull();
  });

  test("a step moves the person and answers with where they are now", async () => {
    const { store, state } = memoryStore({ step: 0, completedAt: null });
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/me/onboarding",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: 2 }),
      },
    );

    expect(response.status).toBe(200);
    expect(state.step).toBe(2);
    await expect(response.json()).resolves.toEqual({
      onboarding: { step: 2, completedAt: null },
    });
  });

  test("completed: true stamps the completion", async () => {
    const { store, state } = memoryStore({ step: 2, completedAt: null });
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/me/onboarding",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(state.completedAt).not.toBeNull();
    const body = (await response.json()) as {
      onboarding: { completedAt: string | null };
    };
    expect(body.onboarding.completedAt).toBe(state.completedAt);
  });

  test.each([
    [{}],
    [{ step: -1 }],
    [{ step: 1.5 }],
    [{ step: "2" }],
    [{ completed: false }],
    // Past the column's range: written as sent, this would be a database error, not a bad request.
    [{ step: 2_147_483_648 }],
  ])("refuses a body it does not understand: %j", async (body) => {
    const { store, state } = memoryStore({ step: 0, completedAt: null });
    const app = appWith(store);

    const response = await app.request(
      "http://openbot.local/api/me/onboarding",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(400);
    expect(state).toEqual({ step: 0, completedAt: null });
  });

  test("answers 503 rather than pretending when there is no store", async () => {
    const app = appWith(undefined);

    const response = await app.request(
      "http://openbot.local/api/me/onboarding",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completed: true }),
      },
    );

    expect(response.status).toBe(503);
  });
});
