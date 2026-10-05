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
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { Route as BoundariesRoute } from "@/routes/_authed/admin/boundaries";

/**
 * Boundaries is drawn from one read, `GET /api/computers/policy`. When that read fails the page
 * used to render its title over nothing, for as long as it stayed open, because nothing read the
 * query's error. The harness is the one `composing-enter.test.tsx` uses for the same screen.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let policyResponse: () => Response;

beforeEach(() => {
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) =>
      path === "/api/computers/policy"
        ? policyResponse()
        : new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function drawBoundaries() {
  const Boundaries = BoundariesRoute.options.component as ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Boundaries /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("a boundary that could not be read says so instead of leaving the page blank", async () => {
  // The shape a broken server actually sends: a 500 with no body, so the query's own sentence.
  policyResponse = () => new Response(null, { status: 500 });

  const view = drawBoundaries();

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe("The boundary could not be read.");
});

test("a refused read shows the server's own reason", async () => {
  policyResponse = () =>
    Response.json(
      { error: "Only an administrator may read the boundary." },
      { status: 403 },
    );

  const view = drawBoundaries();

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Only an administrator may read the boundary.",
  );
});
