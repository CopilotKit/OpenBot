import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's second slide promised "Each Bot has its own computer". Bots now share one computer
 * per person, each with its own browser and folder there, and only an Isolated Bot gets a computer
 * of its own, so the slide says what every Bot does get.
 *
 * Mounts the real onboarding route as a memory router's root, the way `agent-roster-error.test.tsx`
 * mounts home, and walks to the slide with the person's own click.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the computer slide says what every Bot gets, not a computer of its own", async () => {
  const rootRoute = createRootRoute({
    component: OnboardingRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  fireEvent.click(
    await view.findByRole("button", { name: "Continue" }, { timeout: 5000 }),
  );

  const heading = await view.findByRole(
    "heading",
    { level: 1, name: "Each Bot has its own browser and files" },
    { timeout: 5000 },
  );
  expect(heading).toBeTruthy();
  expect(view.queryByText(/its own computer/i)).toBeNull();
});
