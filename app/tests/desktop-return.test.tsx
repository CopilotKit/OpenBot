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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  DESKTOP_LINK,
  DesktopReturn,
} from "@/components/desktop/desktop-return";
import { CONSENT_COUNTDOWN_SECONDS } from "@/lib/plugins/consent-handoff";
import { routeTree } from "@/routeTree.gen";
import { connectionsProblem } from "./connections-api";

/**
 * The page an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser.
 *
 * That browser is not the window, and the personal edition only admits requests carrying its
 * install's token, which only the window has. So the page asks the API nothing: it says how the
 * sign-in went, counts down so it can be read, then follows `openbot://open` to bring the Desktop
 * window forward, which confirms the account itself when it has the focus again. Loaded in the
 * window itself, it goes to the account's page.
 */

const realFetch = globalThis.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:57220/" }));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterAll(() => GlobalRegistrator.unregister());

/** The page, with an API that refuses the person's browser, as it does without the token. */
function show(app: string | undefined, status?: string) {
  const asked: string[] = [];
  const opened: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${String(input)}`);
    return connectionsProblem(
      403,
      "This OpenBot only answers its own app. Open it from the OpenBot app, or use an API key.",
    );
  }) as unknown as typeof fetch;
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/desktop-return"] }),
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/desktop-return",
        component: () => (
          <DesktopReturn
            app={app}
            openDesktop={(link) => opened.push(link)}
            status={status}
          />
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

test("in the browser, it says the app is connected, counts down, then brings OpenBot Desktop forward", async () => {
  const { asked, opened, view } = show("composio-gmail", "success");

  expect(
    await view.findByRole("heading", { name: "Gmail is connected" }),
  ).toBeTruthy();
  expect(view.getByText("Bots that have Gmail can use it now.")).toBeTruthy();
  // It stays to be read: the countdown starts at 5 and nothing has handed back yet.
  expect(view.getByTestId("return-countdown").textContent).toBe(
    `Back to OpenBot in ${CONSENT_COUNTDOWN_SECONDS}`,
  );
  expect(opened).toEqual([]);

  // At 0 it hands back by itself.
  await waitFor(() => expect(opened).toEqual([DESKTOP_LINK]), {
    timeout: (CONSENT_COUNTDOWN_SECONDS + 2) * 1_000,
  });
  expect(
    view.getByText("OpenBot opens on its own. You can close this tab."),
  ).toBeTruthy();
  expect(asked).toEqual([]);
  expect(
    view.getByRole("link", { name: "Open OpenBot" }).getAttribute("href"),
  ).toBe("openbot://open");
}, 15_000);

test("a sign-in the broker reports as failed says nothing was connected", async () => {
  const { view } = show("composio-slack", "failed");

  expect(
    await view.findByRole("heading", { name: "Couldn't connect Slack" }),
  ).toBeTruthy();
  expect(
    view.getByText("Nothing was connected. You can try again in OpenBot."),
  ).toBeTruthy();
});

test("with no app named, Back to OpenBot now hands back at once", async () => {
  const { asked, opened, view } = show(undefined);

  expect(
    await view.findByRole("heading", { name: "Back to OpenBot" }),
  ).toBeTruthy();
  expect(opened).toEqual([]);
  fireEvent.click(view.getByText("Back to OpenBot now"));
  expect(opened).toEqual([DESKTOP_LINK]);
  expect(asked).toEqual([]);
});

/** It renders for a browser nobody is signed in to, so it is not behind sign-in. */
test("the page is not behind sign-in", () => {
  // Only the routes are read; nothing loads, so no context is needed.
  const router = createRouter({ routeTree, context: {} as never });
  const route = router.routesById[
    "/desktop-return" as keyof typeof router.routesById
  ] as { parentRoute?: { id: string } } | undefined;
  expect(route?.parentRoute?.id).toBe("__root__");
  expect(
    router.routesById[
      "/_authed/desktop-return" as keyof typeof router.routesById
    ],
  ).toBeUndefined();
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
