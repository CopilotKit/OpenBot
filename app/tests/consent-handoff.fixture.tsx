import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ConnectAppCard } from "@/components/channels/connect-app-card";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as AccountRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as ConnectingRoute } from "@/routes/connecting";
import { Route as DesktopReturnRoute } from "@/routes/desktop-return";

/**
 * The screens a sign-in through Composio passes through, as pages of their own for
 * consent-handoff.test.tsx to bundle and load in a real browser: an app's page under Connections
 * (where Connect leaves this tab), a Bot's Connect card in a conversation (where it opens a new
 * one), the step that new tab shows (`/connecting`), and the page OpenBot Desktop's sign-in comes
 * back to (`/desktop-return`). Each is the app's own route or component; what the server answers
 * comes from the test's routes.
 *
 * The tree is built the way `routeTree.gen.ts` builds it, a pathless `_authed` and `_app` above
 * the account page, with the guards left out: there is no sign-in in front of this page.
 */
setCurrentOrganization("default");

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authed",
});
const appRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "_app",
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
      <Outlet />
    </div>
  ),
});

/** One of the app's file routes, placed where the generated tree places it. */
const placed = (
  route: unknown,
  parent: () => unknown,
  id: string,
  path: string,
) =>
  (route as { update: (options: unknown) => never }).update({
    id,
    path,
    getParentRoute: parent,
  });

/** A page these screens link to and never open. */
const elsewhere = (path: string) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    component: () => null,
  });

/** A Bot's Connect card, as a conversation draws it for an app it needed. */
const cardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/card/$key",
  component: function Card() {
    const { key } = cardRoute.useParams();
    const title = key === "composio-slack" ? "Slack" : "Gmail";
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ConnectAppCard
          message={`The Bot needs your ${title} account to do this.`}
          serverId={key}
          title={title}
        />
      </div>
    );
  },
});

const router = createRouter({
  history: createBrowserHistory(),
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([
      appRoute.addChildren([
        placed(
          AccountRoute,
          () => appRoute,
          "/connections/$key",
          "/connections/$key",
        ),
        cardRoute,
        elsewhere("/connections"),
        elsewhere("/connections/browse/composio"),
        elsewhere("/settings/vault"),
      ]),
    ]),
    placed(ConnectingRoute, () => rootRoute, "/connecting", "/connecting"),
    placed(
      DesktopReturnRoute,
      () => rootRoute,
      "/desktop-return",
      "/desktop-return",
    ),
  ]),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
