import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UserPreferences } from "@openbot/shared/user-preferences";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { authKeys } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as HomeRoute } from "@/routes/_authed/_app/index";
import { Route as ScreenRoute } from "@/routes/_authed/_app/s/$screen";
import { SkinAccountSync } from "@/skins/account-sync";
import { SKINS } from "@/skins/registry";
import { SkinPicker } from "@/skins/skin-picker";
import {
  clearSkin,
  getSkinId,
  SKIN_STORAGE_KEY,
  setSkin,
  useSkinId,
} from "@/skins/store";
import { settleReactWork } from "./settle-react-work";

/*
 * The skin is saved on the person's account. These drive it the way a person does: the picker on
 * Settings, a reload whose cached skin is not the account's, signing out on a shared machine, and
 * the account's skin changing under a screen only the old skin had. The API is a fake that answers
 * in the shapes OpenBot's endpoints send; the store, the sync, the picker and the routes are real.
 */

class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}

type Sent = { method: string; path: string; body: unknown };

const alice = {
  id: "alice",
  name: "Alice Park",
  email: "alice@example.com",
  role: "user" as const,
  onboarding: null,
};

function preferences(skin: UserPreferences["skin"]): UserPreferences {
  return {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin,
  };
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let sent: Sent[];
/** Answers keyed by `METHOD path`; anything else is a 404, as an unknown route is. */
let answers: Map<string, () => Promise<Response>>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
});
beforeEach(() => {
  sent = [];
  answers = new Map();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
      }
      const answer = answers.get(`${method} ${path}`);
      if (answer) return answer();
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  queryClient.clear();
  clearSkin();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function serve(key: string, body: unknown, status = 200) {
  answers.set(key, async () => Response.json(body, { status }));
}

function signedIn() {
  queryClient.setQueryData(authKeys.currentUser(), alice);
}

function cachedSkin() {
  return window.localStorage.getItem(SKIN_STORAGE_KEY);
}

function SkinProbe() {
  return <output aria-label="Drawn skin">{useSkinId()}</output>;
}

function renderSettings() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SkinAccountSync />
      <SkinProbe />
      <SkinPicker />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document });
  return { view, user };
}

test("picking a skin draws it at once and saves it on the account", async () => {
  signedIn();
  serve("GET /api/settings/preferences", {
    preferences: preferences("openbot"),
  });
  const save = Promise.withResolvers<Response>();
  answers.set("PATCH /api/settings/preferences", () => save.promise);
  const { view, user } = renderSettings();

  const picker = view.getByRole("combobox", { name: "Skin" });
  await waitFor(() => expect(picker.getAttribute("data-disabled")).toBeNull());
  // The default skin goes by the product's own name, whatever brand.yaml calls it.
  expect(picker.textContent).toContain(appConfig.brand.productName);

  await user.click(picker);
  const option = await view.findByRole("option", { name: /^OpenDots/ });
  // Each choice says what it is.
  expect(option.textContent).toContain(SKINS.opendots.description);
  await user.click(option);

  // Drawn before the server has answered.
  await waitFor(() =>
    expect(view.getByLabelText("Drawn skin").textContent).toBe("opendots"),
  );
  expect(document.documentElement.dataset.skin).toBe("opendots");
  expect(cachedSkin()).toBe("opendots");
  expect(sent).toEqual([
    {
      method: "PATCH",
      path: "/api/settings/preferences",
      body: { skin: "opendots" },
    },
  ]);

  await act(async () => {
    save.resolve(Response.json({ preferences: preferences("opendots") }));
  });
  await waitFor(() =>
    expect(
      queryClient.getQueryData<UserPreferences>(
        userPreferencesQueryOptions("alice").queryKey,
      )?.skin,
    ).toBe("opendots"),
  );
  expect(getSkinId()).toBe("opendots");
  expect(view.queryByRole("alert")).toBeNull();
});

test("a skin the account could not save is put back, and the picker says so", async () => {
  signedIn();
  setSkin("openduet");
  serve("GET /api/settings/preferences", {
    preferences: preferences("openduet"),
  });
  const save = Promise.withResolvers<Response>();
  answers.set("PATCH /api/settings/preferences", () => save.promise);
  const { view, user } = renderSettings();

  const picker = view.getByRole("combobox", { name: "Skin" });
  await waitFor(() => expect(picker.getAttribute("data-disabled")).toBeNull());
  await user.click(picker);
  await user.click(await view.findByRole("option", { name: /^OpenMuse/ }));
  await waitFor(() => expect(getSkinId()).toBe("openmuse"));

  await act(async () => {
    save.resolve(Response.json({ error: "Storage down" }, { status: 503 }));
  });
  expect((await view.findByRole("alert")).textContent).toContain(
    "Couldn't save that skin to your account, so OpenDuet is back.",
  );
  expect(view.getByLabelText("Drawn skin").textContent).toBe("openduet");
  expect(document.documentElement.dataset.skin).toBe("openduet");
  expect(cachedSkin()).toBe("openduet");
  expect(
    queryClient.getQueryData<UserPreferences>(
      userPreferencesQueryOptions("alice").queryKey,
    )?.skin,
  ).toBe("openduet");
});

test("the account's skin wins over a different one this browser cached", async () => {
  signedIn();
  // What a reload paints first: the cached skin, before the preferences have answered.
  setSkin("openmuse");
  const read = Promise.withResolvers<Response>();
  answers.set("GET /api/settings/preferences", () => read.promise);
  const { view } = renderSettings();
  expect(view.getByLabelText("Drawn skin").textContent).toBe("openmuse");

  await act(async () => {
    read.resolve(Response.json({ preferences: preferences("opendots") }));
  });
  await waitFor(() =>
    expect(view.getByLabelText("Drawn skin").textContent).toBe("opendots"),
  );
  expect(document.documentElement.dataset.skin).toBe("opendots");
  // And the cache now holds the account's skin, so the next reload paints it straight away.
  expect(cachedSkin()).toBe("opendots");
  // Applying what the account holds saves nothing back to it.
  expect(sent).toEqual([]);
});

test("signing out forgets the cached skin, so the next person starts from the default", async () => {
  signedIn();
  setSkin("openduet");
  expect(cachedSkin()).toBe("openduet");
  serve("POST /api/auth/sign-out", { success: true });

  // The one sign-out every menu uses: OpenBot's sidebar and each skin's own.
  await queryClient
    .getMutationCache()
    .build(queryClient, signOutMutationOptions(queryClient))
    .execute(undefined);

  expect(cachedSkin()).toBeNull();
  expect(document.documentElement.dataset.skin).toBeUndefined();
  expect(getSkinId()).toBe("openbot");
  expect(queryClient.getQueryData(authKeys.currentUser())).toBeUndefined();
});

test("a sign-out the server refused keeps the skin", async () => {
  signedIn();
  setSkin("openduet");
  serve("POST /api/auth/sign-out", { error: "Try again" }, 500);

  await expect(
    queryClient
      .getMutationCache()
      .build(queryClient, signOutMutationOptions(queryClient))
      .execute(undefined),
  ).rejects.toThrow();
  expect(cachedSkin()).toBe("openduet");
  expect(getSkinId()).toBe("openduet");
});

/*
 * `_authed/_app` and `/s/$screen` exactly as the app registers them: the active skin's Frame around
 * the page, and its own screen at `/s/<key>`. The route ids match the file routes', so the screen
 * route's own `Route.useParams()` resolves here as it does in the app.
 */
function renderApp(path: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <SkinAccountSync />
        <Outlet />
      </>
    ),
  });
  const authed = createRoute({
    id: "_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const app = createRoute({
    id: "_app",
    getParentRoute: () => authed,
    component: AppRoute.options.component,
  });
  const home = createRoute({
    path: "/",
    getParentRoute: () => app,
    component: HomeRoute.options.component,
  });
  const screen = createRoute({
    path: "s/$screen",
    getParentRoute: () => app,
    component: ScreenRoute.options.component,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([app.addChildren([home, screen])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

/** `/` mounts the rich-text composer; see `agent-roster-error.test.tsx` on why it needs headroom. */
const HOME = { timeout: 5000 };

test("a skin switched while on a screen only the old skin has lands on home, drawn", async () => {
  const from = SKINS.openduet;
  const to = SKINS.opendots;
  const key = Object.keys(from.screens ?? {}).find(
    (screen) => !to.screens?.[screen],
  );
  if (!key) throw new Error("OpenDuet has no screen OpenDots lacks");

  signedIn();
  setSkin("openduet");
  queryClient.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences("openduet"),
  );
  serve("GET /api/agents", { agents: [] });
  serve("GET /api/channels", { channels: [], nextCursor: null });
  serve("GET /api/bots/attention", { bots: [] });
  const { view, router } = renderApp(`/s/${key}`);
  await waitFor(() =>
    expect(document.querySelector("[data-openduet-frame]")).not.toBeNull(),
  );
  expect(router.state.location.pathname).toBe(`/s/${key}`);

  // The person switched skins on another device; this tab's preferences catch up.
  act(() => {
    queryClient.setQueryData(
      userPreferencesQueryOptions("alice").queryKey,
      preferences("opendots"),
    );
  });

  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(getSkinId()).toBe("opendots");
  expect(document.querySelector("[data-openduet-frame]")).toBeNull();
  // Home, inside the new skin's frame, with something on it.
  expect(
    // Home draws its composer; its greeting is personal, so it is not what this waits for.
    await view.findByRole("textbox", { name: "Message" }, HOME),
  ).toBeTruthy();
  expect(document.querySelector("[data-opendots-main]")).not.toBeNull();
});
