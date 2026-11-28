import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { ADMIN_SECTIONS } from "@/components/admin/admin-sections";
import {
  ConnectProviderPage,
  ProviderPage,
} from "@/components/settings/provider-pages";
import { SETTINGS_SIDEBAR_ITEMS } from "@/components/settings/settings-sidebar";
import { queryClient } from "@/query-client";
import { ProvidersPage as AdminProvidersPage } from "@/routes/_authed/admin/providers";
import { Route as SettingsProvidersRoute } from "@/routes/_authed/settings/providers";
import { settleReactWork } from "./settle-react-work";

/*
 * Reported on 1.2.0: "hard to find LLM providers". Settings' Every Bot group listed the place to
 * connect the AI Bots run on as just "Providers", which doesn't say what it provides. It is "AI
 * providers" everywhere a person reads its name: the Settings entry, Admin's entry, the page's
 * heading, and the Back link on every page under it. The address stays /settings/providers.
 */

const NAME = "AI providers";
const to = (linkOptions: unknown) => (linkOptions as { to?: string }).to;
const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** The server answers nothing, or never: only the page's own words are under test. */
function serverAnswers(how: "nothing" | "never") {
  global.fetch = Object.assign(
    async () =>
      how === "never"
        ? new Promise<Response>(() => {})
        : new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
}

async function draw(Page: ComponentType) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("Settings and Admin list it as AI providers, at the addresses it always had", () => {
  const settings = SETTINGS_SIDEBAR_ITEMS.find(
    (item) => to(item.linkOptions) === "/settings/providers",
  );
  expect(settings?.title).toBe(NAME);
  expect(settings?.group).toBe("every-bot");

  const admin = ADMIN_SECTIONS.flatMap((section) => section.items).find(
    (entry) => to(entry.linkOptions) === "/admin/providers",
  );
  expect(admin?.title).toBe(NAME);
});

test("Settings' page is headed AI providers", async () => {
  serverAnswers("nothing");
  const view = await draw(
    SettingsProvidersRoute.options.component as ComponentType,
  );
  const heading = await view.findByRole("heading", { level: 1 });
  expect(heading.textContent).toBe(NAME);
});

test("Admin's page is headed AI providers", async () => {
  serverAnswers("nothing");
  const view = await draw(AdminProvidersPage);
  const heading = await view.findByRole("heading", { level: 1 });
  expect(heading.textContent).toBe(NAME);
});

test("a provider's page and Connect another AI go back to AI providers", async () => {
  serverAnswers("never");
  for (const Page of [
    () => <ProviderPage id="openai" scope="organization" />,
    () => <ConnectProviderPage scope="organization" />,
  ]) {
    const view = await draw(Page);
    // Drawn as a button (Button's own role) that is a link to the list.
    const back = await view.findByRole("button", { name: NAME });
    expect(back.getAttribute("href")).toBe("/settings/providers");
    view.unmount();
  }
});
