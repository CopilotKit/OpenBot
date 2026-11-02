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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { authKeys } from "@/lib/auth/queries";
import { BOT_FACES_STORAGE_KEY, parseBotFaces } from "@/lib/bot-faces";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { settingsKeys } from "@/lib/settings/queries";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { Route as SettingsRoute } from "@/routes/_authed/settings/index";

beforeAll(() => GlobalRegistrator.register());
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

async function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    name: "Alice",
    role: "user",
    onboarding: null,
  });
  const preferences: UserPreferences = {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
    narration: null,
    skin: "openbot",
  };
  queryClient.setQueryData(
    userPreferencesQueryOptions("alice").queryKey,
    preferences,
  );
  queryClient.setQueryData(settingsKeys.instructions(), "");
  const rootRoute = createRootRoute({
    component: SettingsRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await view.findByText("Appearance");
  return view;
}

/** The choices in the radio group named `name`, and which one is on. */
function choices(
  view: Awaited<ReturnType<typeof renderSettings>>,
  name: string,
) {
  const group = view.getByRole("radiogroup", { name });
  const radios = within(group).getAllByRole("radio");
  return {
    group,
    radios,
    labels: radios.map((radio) => radio.textContent),
    checked: radios
      .filter((radio) => radio.getAttribute("aria-checked") === "true")
      .map((radio) => radio.textContent),
  };
}

test("Appearance offers System, Light and Dark side by side, as a radio group", async () => {
  const view = await renderSettings();
  expect(view.queryByRole("switch", { name: "Dark theme" })).toBeNull();
  expect(view.queryByRole("combobox", { name: "Appearance" })).toBeNull();
  const appearance = choices(view, "Appearance");
  expect(appearance.labels).toEqual(["System", "Light", "Dark"]);
  expect(appearance.checked).toEqual(["System"]);
});

test("choosing Dark draws it, remembers it, and says what it does", async () => {
  const view = await renderSettings();
  expect(
    view.getByText("OpenBot follows your device's light or dark setting."),
  ).toBeTruthy();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("radio", { name: "Dark" }));

  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(choices(view, "Appearance").checked).toEqual(["Dark"]);
  expect(
    view.getByText("OpenBot stays dark, whatever your device is set to."),
  ).toBeTruthy();
  expect(
    view.queryByText("OpenBot follows your device's light or dark setting."),
  ).toBeNull();
});

test("Bot faces offers Animated, Only while working and Still, and remembers the choice", async () => {
  const view = await renderSettings();
  const faces = choices(view, "Bot faces");
  expect(faces.labels).toEqual(["Animated", "Only while working", "Still"]);
  expect(faces.checked).toEqual(["Animated"]);
  expect(
    view.getByText("Bot faces blink, look around and follow your pointer."),
  ).toBeTruthy();

  const user = userEvent.setup({ document });
  await user.click(view.getByRole("radio", { name: "Only while working" }));
  expect(window.localStorage.getItem(BOT_FACES_STORAGE_KEY)).toBe("working");
  expect(choices(view, "Bot faces").checked).toEqual(["Only while working"]);
  expect(
    view.getByText("Bot faces move only while a Bot is listening or working."),
  ).toBeTruthy();

  await user.click(view.getByRole("radio", { name: "Still" }));
  expect(window.localStorage.getItem(BOT_FACES_STORAGE_KEY)).toBe("still");
  expect(view.getByText("Bot faces never move.")).toBeTruthy();
});

test("Bot faces says so when the device asks for less motion", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  try {
    const view = await renderSettings();
    expect(
      view.getByText(
        "Your device asks for less motion, so Bot faces never move.",
      ),
    ).toBeTruthy();
  } finally {
    window.matchMedia = original;
  }
});

test("a stored Bot faces choice is read back, and anything else is Animated", () => {
  expect(parseBotFaces("working")).toBe("working");
  expect(parseBotFaces("still")).toBe("still");
  expect(parseBotFaces("animated")).toBe("animated");
  expect(parseBotFaces(null)).toBe("animated");
  expect(parseBotFaces("dark")).toBe("animated");
});
