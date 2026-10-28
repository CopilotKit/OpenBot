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
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { authKeys } from "@/lib/auth/queries";
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

test("Appearance offers System, Light and Dark where the dark switch was", async () => {
  const view = await renderSettings();
  expect(view.queryByRole("switch", { name: "Dark theme" })).toBeNull();
  const appearance = view.getByRole("combobox", { name: "Appearance" });
  expect(appearance.textContent).toContain("System");

  const user = userEvent.setup({ document });
  await user.click(appearance);
  const options = (await view.findAllByRole("option")).map(
    (option) => option.textContent,
  );
  expect(options).toEqual(["System", "Light", "Dark"]);
});

test("choosing Dark draws it and remembers it", async () => {
  const view = await renderSettings();
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("combobox", { name: "Appearance" }));
  await user.click(await view.findByRole("option", { name: "Dark" }));

  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(
    view.getByRole("combobox", { name: "Appearance" }).textContent,
  ).toContain("Dark");
});
