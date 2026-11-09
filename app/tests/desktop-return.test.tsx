import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  DESKTOP_LINK,
  DesktopReturn,
} from "@/components/desktop/desktop-return";

/**
 * The page an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser.
 *
 * It confirms the account, as the account's page does on arrival, and then follows `openbot://open`
 * to bring the Desktop window forward. Loaded in the window itself, it goes to the account's page.
 */

const realFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:57220/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(() => GlobalRegistrator.unregister());

function show(
  app: string | undefined,
  answer = () => Response.json({ connected: true }),
) {
  const asked: string[] = [];
  const opened: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${String(input)}`);
    return answer();
  }) as unknown as typeof fetch;
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/desktop-return"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/desktop-return",
        component: () => (
          <DesktopReturn app={app} openDesktop={(link) => opened.push(link)} />
        ),
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/connections/$key",
        component: () => <p>The account's page</p>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { asked, opened, router, view };
}

test("in the browser, it confirms the account and then brings OpenBot Desktop forward", async () => {
  const { asked, opened, view } = show("gmail");

  expect(
    await view.findByRole("heading", { name: "Back to OpenBot" }),
  ).toBeTruthy();
  await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]));
  expect(asked).toContain("POST /api/plugins/servers/gmail/connection/confirm");
  expect(
    view.getByRole("link", { name: "Open OpenBot" }).getAttribute("href"),
  ).toBe("openbot://open");
});

test("a confirm that fails still hands the person back", async () => {
  const { asked, opened } = show("gmail", () =>
    Response.json({ error: "no" }, { status: 503 }),
  );

  await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]));
  expect(asked).toContain("POST /api/plugins/servers/gmail/connection/confirm");
});

test("in the Desktop window itself, it goes to the account's page", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async () => null,
    transformCallback: () => 0,
  };
  const { opened, router, view } = show("gmail");

  expect(await view.findByText("The account's page")).toBeTruthy();
  expect(router.state.location.pathname).toBe("/connections/gmail");
  expect(opened).toEqual([]);
});
