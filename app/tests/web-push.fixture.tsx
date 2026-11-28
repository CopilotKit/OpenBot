import { IconPlayerPause } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { WebPushKeeper } from "@/components/delivery/web-push-keeper";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { NotificationsOfferRow } from "@/components/notifications/notifications-offer-row";
import { NotifyPrompt } from "@/components/notifications/notify-prompt";
import { ThemeProvider } from "@/components/theme-provider";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { useServiceWorkerOpenRequests } from "@/lib/web-push/open-requests";
import { queryClient } from "@/query-client";
import { Route as NotificationsRoute } from "@/routes/_authed/settings/notifications";

/**
 * Settings, Notifications, as a page of its own for web-push-browser.test.tsx to bundle and load in
 * a browser, at /settings/notifications. And a conversation at /channel/<id>, where a click on a
 * push notification lands. The test serves the API at the page's own address, as the server does,
 * and the service worker from public/sw.js.
 *
 * Mounted as the app mounts them: the keeper that saves this browser's subscription at every start,
 * and the root's opening of a page a clicked notification sent.
 */
setCurrentOrganization("default");
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
});

const Notifications = NotificationsRoute.options.component as ComponentType;

function Conversation() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  return <p className="p-8 text-sm">Conversation {channelId}</p>;
}

/** The offer above a conversation's message box, in the composer's column as the conversation lays it. */
function ConversationOffer() {
  return (
    <div className="mx-auto w-full max-w-[calc(var(--container-3xl)+2rem)] shrink-0 px-4 pt-12 pb-4">
      <NotifyPrompt />
    </div>
  );
}

/** A Bot's page's card, with its notifications row as the page draws it under the rows above it. */
function BotOffer() {
  return (
    <PageShell description="Finds what you need to know." title="Research">
      <PageSection>
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlayerPause />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Working</ItemTitle>
              <ItemDescription>It runs its routines.</ItemDescription>
            </ItemContent>
          </Item>
          <NotificationsOfferRow />
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

function Root() {
  useServiceWorkerOpenRequests();
  return (
    <div className="bg-background text-foreground">
      <ThemeProvider>
        <WebPushKeeper />
        <div className="flex min-h-svh flex-col">
          <Outlet />
        </div>
      </ThemeProvider>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Root });
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/notifications",
      component: () => <Notifications />,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: Conversation,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/conversation-offer",
      component: ConversationOffer,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bot-offer",
      component: BotOffer,
    }),
  ]),
  history: createBrowserHistory(),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
