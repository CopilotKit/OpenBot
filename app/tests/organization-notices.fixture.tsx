import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PageShell } from "@/components/layout/page-shell";
import { OrganizationBoundary } from "@/components/organizations/organization-boundary";
import { TeamDetailPage } from "@/components/teams/team-page";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProposedBotRender } from "@/lib/copilot/bot-tools";
import { ReportedErrorComponent } from "@/lib/error-reporting";
import { queryClient } from "@/query-client";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as AppRoute } from "@/routes/_authed/_app";
import { Route as MemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { Route as TeamsRoute } from "@/routes/_authed/_app/teams";
import { Route as TermsRoute } from "@/routes/_authed/terms";

/**
 * The app as organization-moving.test.tsx, organization-removed.test.tsx,
 * organization-held-reload.test.tsx and organization-held-recovery.test.tsx load it in a browser:
 * the signed-in gate itself (`_authed`'s own `beforeLoad`: who is signed in and the organization they
 * work in, then the terms, onboarding and the AI connection), the terms screen it sends people to,
 * the organization boundary `_authed` puts around everything, and the app's real frame
 * (`_authed/_app`: the strip, its panels and every bar over the page). The routes keep the app's own
 * ids, so a screen that reads its own route (the terms screen reads `?next=`) finds it. Inside the
 * frame, Routines is the real page; home is a stand-in heading. Memory and Teams are the real pages
 * too, and so are a team's page and the card a Bot proposes a new Bot on
 * (organization-held-actions.test.tsx). OpenBot's API is the test's routes.
 *
 * `window.openbotRouter` lets the test move between pages as a link does, at any window width, and
 * `window.openbotQueryClient` lets it drop an answer the app kept, as the cache does by itself with
 * an answer nothing has shown for five minutes.
 */
const rootRoute = createRootRoute({
  component: () => (
    <OrganizationBoundary>
      <Outlet />
    </OrganizationBoundary>
  ),
});

// The signed-in gate, as routes/_authed.tsx has it.
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_authed",
  beforeLoad: (args) => AuthedRoute.options.beforeLoad?.(args as never),
  errorComponent: AuthedRoute.options.errorComponent,
  component: Outlet,
});

// Where the gate sends somebody with terms to agree to, as routes/_authed/terms.tsx has it.
const termsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/terms",
  validateSearch: TermsRoute.options.validateSearch as (
    search: Record<string, unknown>,
  ) => { next?: string },
  beforeLoad: (args) => TermsRoute.options.beforeLoad?.(args as never),
  component: TermsRoute.options.component as () => ReactNode,
});

const appRoute = createRoute({
  getParentRoute: () => authedRoute,
  id: "_app",
  component: AppRoute.options.component as () => ReactNode,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => (
    <PageShell title="Home">
      <p>Start a conversation.</p>
    </PageShell>
  ),
});

const routinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/routines",
  component: RoutinesRoute.options.component as () => ReactNode,
});

// Memory and Teams draw a failed read in the error's own words (organization-unavailable-pages.test.tsx).
// Memory's page without its route's edition check: the test's deployment offers memory.
const memoryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/memory",
  component: MemoryRoute.options.component as () => ReactNode,
});

const teamsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teams",
  component: TeamsRoute.options.component as () => ReactNode,
});

// A press refused while Northwind is held (organization-held-actions.test.tsx): adding somebody to a
// team on the team's real page, and creating a Bot from the card a Bot puts in a conversation.
const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/teams/$teamId",
  component: function Team() {
    const { teamId } = teamRoute.useParams();
    return <TeamDetailPage teamId={teamId} />;
  },
});

// The card as a conversation draws it, with the run waiting on the person's answer.
const proposedBotRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/propose-bot",
  component: () => (
    <PageShell title="Conversation">
      <ProposedBotRender
        args={{
          name: "Renewal Desk",
          title: "Accounts Receivable",
          roleDescription:
            "Follow up on renewals that are due this month. Say which ones are late.",
        }}
        respond={async () => {}}
      />
    </PageShell>
  ),
});

const router = createRouter({
  history: createBrowserHistory(),
  // What every gate is handed, as router.tsx gives it.
  context: { queryClient },
  // The app's own error boundary, as router.tsx gives every route.
  defaultErrorComponent: ReportedErrorComponent,
  routeTree: rootRoute.addChildren([
    authedRoute.addChildren([
      termsRoute,
      appRoute.addChildren([
        homeRoute,
        routinesRoute,
        memoryRoute,
        teamsRoute,
        teamRoute,
        proposedBotRoute,
      ]),
    ]),
  ]),
});

(window as unknown as { openbotRouter: unknown }).openbotRouter = router;
(window as unknown as { openbotQueryClient: unknown }).openbotQueryClient =
  queryClient;

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
