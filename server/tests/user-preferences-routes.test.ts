import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";
import type { UserPreferencesStore } from "../src/user-preferences";
import { userPreferencesRoutes } from "../src/user-preferences-routes";

function fixture() {
  const state = new Map<string, UserPreferences>();
  const store: UserPreferencesStore = {
    read: async (id) => state.get(id) ?? DEFAULT_USER_PREFERENCES,
    patch: async (id, patch) => {
      const saved = { ...DEFAULT_USER_PREFERENCES, ...state.get(id), ...patch };
      state.set(id, saved);
      return saved;
    },
  };
  function appFor(userId: string | null, available = true) {
    return new Hono().route(
      "/api/settings/preferences",
      userPreferencesRoutes(
        async (context, next) => {
          if (!userId) return context.json({ error: "Sign in" }, 401);
          context.set("actor", {
            id: userId,
            email: `${userId}@example.com`,
            role: "user",
          });
          await next();
        },
        available ? store : undefined,
      ),
    );
  }
  return { state, appFor };
}

const path = "/api/settings/preferences";
function patch(body: unknown) {
  return {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("preferences default to thread and persist separately for each authenticated user", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  expect(await (await alice.request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
    },
  });
  const saved = await alice.request(
    path,
    patch({ messageListEmphasis: "agent" }),
  );
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
    },
  });
});

test.each([
  {},
  null,
  { selfHostBannerDismissed: "yes" },
  { messageListEmphasis: "invalid" },
  { messageListEmphasis: "agent", userId: "bob" },
])("rejects invalid or extra preference fields: %j", async (body) => {
  const { appFor, state } = fixture();
  expect((await appFor("alice").request(path, patch(body))).status).toBe(400);
  expect(state.size).toBe(0);
});

test("refuses malformed JSON, unauthenticated callers, and unavailable storage", async () => {
  const { appFor, state } = fixture();
  expect(
    (await appFor("alice").request(path, { method: "PATCH", body: "{" }))
      .status,
  ).toBe(400);
  for (const request of [undefined, patch({ messageListEmphasis: "agent" })]) {
    expect((await appFor(null).request(path, request)).status).toBe(401);
    expect((await appFor("alice", false).request(path, request)).status).toBe(
      503,
    );
  }
  expect(state.size).toBe(0);
});

test("saves the self-host banner dismissal without touching message list emphasis", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  await alice.request(path, patch({ messageListEmphasis: "agent" }));
  const saved = await alice.request(
    path,
    patch({ selfHostBannerDismissed: true }),
  );
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: true,
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
    },
  });
});
