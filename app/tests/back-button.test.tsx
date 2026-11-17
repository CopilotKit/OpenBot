import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
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
import { PageShell } from "@/components/layout/page-shell";
import { SidebarProvider } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/*
 * With places on, the page bar holds one Back button that goes back through history, and the
 * parent link beside it keeps its label but loses its own chevron. With places off nothing changes.
 */

beforeAll(() => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 840,
  });
});
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function renderAt(path: string, places: boolean) {
  if (places) localStorage.setItem("openbot-places", "on");
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const bots = createRoute({
    getParentRoute: () => root,
    path: "/bots",
    component: () => <PageShell title="Bots">list</PageShell>,
  });
  const bot = createRoute({
    getParentRoute: () => root,
    path: "/bots/$agentId",
    component: () => (
      <PageShell
        title="A Bot"
        backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
      >
        page
      </PageShell>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([bots, bot]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
}

const chevron = (link: HTMLElement) =>
  link.querySelector("svg.tabler-icon-chevron-left");

test("Back is inert on the first page", async () => {
  const { findByRole } = renderAt("/bots", true);
  const back = await findByRole("button", { name: "Back" });
  expect((back as HTMLButtonElement).disabled).toBe(true);
});

test("Back returns to the page you were on", async () => {
  const { router, findByRole } = renderAt("/bots", true);
  await findByRole("button", { name: "Back" });
  await router.navigate({ to: "/bots/$agentId", params: { agentId: "b1" } });
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots/b1"));
  const back = await findByRole("button", { name: "Back" });
  await waitFor(() => expect((back as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(back);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bots"));
});

test("with places off there is no Back and the parent link keeps its chevron", async () => {
  const { findByText, queryByRole } = renderAt("/bots/b1", false);
  const link = await findByText("Bots");
  expect(queryByRole("button", { name: "Back" })).toBeNull();
  expect(chevron(link)).not.toBeNull();
});

test("with places on the parent link loses its chevron", async () => {
  const { findByRole, findByText } = renderAt("/bots/b1", true);
  const link = await findByText("Bots");
  expect(chevron(link)).toBeNull();
  await findByRole("button", { name: "Back" });
});
