import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { Toaster } from "@/components/ui/toast";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Sign out, from the sidebar's user menu. The server ends the person's Recorders before their session, and when it
 * cannot it does not sign them out (server/src/auth/index.ts, server/src/auth/organization.ts): the person stays signed
 * in, where they were, told so in a toast, and can sign out again. Better Auth refuses with its sentence in `message`,
 * the organization's sign-in in `error`; either way the person reads one plain sentence.
 */

const UNFINISHED = "Signing out did not finish. Try again.";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** How the server answers the next sign-out. */
let answer: () => Response;
const originalFetch = global.fetch;
beforeEach(() => {
  queryClient.clear();
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/api/auth/sign-out")
        ? answer()
        : new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function SignOutButton() {
  const signOut = useSignOut();
  return (
    <button type="button" disabled={signOut.pending} onClick={signOut.run}>
      Sign out
    </button>
  );
}

/** The menu's Sign out on a router with the sign-in screen, with the app's one query client and its toasts. */
function draw() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <Toaster />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: SignOutButton,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/sign",
        component: () => <p>Sign in</p>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const toasts = () =>
  [...document.querySelectorAll("[data-slot=toast]")].map(
    (toast) => toast.textContent,
  );

for (const [who, body] of [
  ["Better Auth", { code: "SERVICE_UNAVAILABLE", message: UNFINISHED }],
  ["the organization's sign-in", { error: UNFINISHED }],
] as const) {
  test(`a sign-out ${who} could not finish leaves the person here, told so, and Sign out works again`, async () => {
    answer = () => Response.json(body, { status: 503 });
    const { view, router } = draw();
    const button = await view.findByRole("button", { name: "Sign out" });
    await userEvent.click(button);
    await waitFor(() => expect(toasts()).toEqual([UNFINISHED]));
    expect(router.state.location.pathname).toBe("/");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));

    // Signing out again, once the server can: the person reaches the sign-in screen, and the note goes.
    answer = () => Response.json({ success: true });
    await userEvent.click(button);
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
    await waitFor(() => expect(toasts()).toEqual([]));
  });
}
