import { expect, test } from "bun:test";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { Hono } from "hono";
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
      narration: null,
      skin: "openbot",
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
      narration: null,
      skin: "openbot",
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      narration: null,
      skin: "openbot",
    },
  });
});

test.each([
  {},
  null,
  { selfHostBannerDismissed: "yes" },
  { messageListEmphasis: "invalid" },
  { narration: "always" },
  { narration: null },
  { messageListEmphasis: "agent", userId: "bob" },
  { skin: "retired-skin" },
  { skin: "" },
  { skin: null },
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
      narration: null,
      skin: "openbot",
    },
  });
  expect(await (await appFor("bob").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      narration: null,
      skin: "openbot",
    },
  });
});

test("keeps the person's narration choice without touching the others, and starts with none made", async () => {
  // The Browser page asks before the first recording, and the microphone stays closed until it is answered.
  const { appFor } = fixture();
  const alice = appFor("alice");
  expect((await (await alice.request(path)).json()).preferences.narration).toBe(
    null,
  );
  await alice.request(path, patch({ messageListEmphasis: "agent" }));
  const saved = await alice.request(path, patch({ narration: "on" }));
  expect(saved.status).toBe(200);
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      narration: "on",
      skin: "openbot",
    },
  });
  await alice.request(path, patch({ narration: "off" }));
  expect(
    (await (await appFor("alice").request(path)).json()).preferences.narration,
  ).toBe("off");
  expect(
    (await (await appFor("bob").request(path)).json()).preferences.narration,
  ).toBe(null);
});

test("saves the skin on the account without touching the other preferences", async () => {
  const { appFor } = fixture();
  const alice = appFor("alice");
  await alice.request(path, patch({ messageListEmphasis: "agent" }));
  const saved = await alice.request(path, patch({ skin: "opendots" }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      narration: null,
      skin: "opendots",
    },
  });
  // Another browser signed in as Alice reads the same skin; Bob keeps the default.
  expect(await (await appFor("alice").request(path)).json()).toEqual({
    preferences: {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
      narration: null,
      skin: "opendots",
    },
  });
  expect(
    (
      (await (await appFor("bob").request(path)).json()) as {
        preferences: UserPreferences;
      }
    ).preferences.skin,
  ).toBe("openbot");
});

test("a skin OpenBot does not ship is refused with the skins it does", async () => {
  const { appFor } = fixture();
  const refused = await appFor("alice").request(
    path,
    patch({ skin: "retired-skin" }),
  );
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "openbot, openduet, opendots, openmuse",
  );
});
