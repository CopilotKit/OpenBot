import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { PendingDeletionGate } from "@/components/auth/pending-deletion-page";
import { ThemeProvider } from "@/components/theme-provider";
import { showPendingDeletion } from "@/lib/account-deletion/pending";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { Route as GeneralRoute } from "@/routes/_authed/settings/index";
import { ME_PATH, meResponse } from "./accounts-api";

/**
 * Settings, General, with its Delete account section, as a page of its own for
 * delete-account-layout.test.tsx to bundle and load in a browser. `?state=`:
 *
 *  - `blockers`: two organizations stand in the way, one Dana is the only owner of and one she
 *    has to leave;
 *  - `clear` (anything else): nothing stands in the way, and the test opens the dialog;
 *  - `reauthenticate`: as clear, and the server asks her to sign in again when she confirms;
 *  - `pending`: her account is scheduled to be deleted, and the app is only the pending page.
 *
 * The server's answers come from a fetch here, as the API gives them, so nothing is asked of a
 * server.
 */
const state = new URLSearchParams(location.search).get("state") ?? "clear";

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
const MINE = {
  organizations: [
    {
      id: "default",
      slug: "dana",
      name: "Dana's organization",
      role: "owner",
      personal: true,
      active: true,
    },
  ],
  canCreate: true,
  nextCursor: null,
};
queryClient.setQueryData(organizationKeys.mine(), {
  ...MINE,
  currentId: "default",
});

const BLOCKERS = [
  {
    organizationId: "org_acme",
    organizationName: "Acme Freight",
    reason: "only_owner",
  },
  {
    organizationId: "org_globex",
    organizationName: "Globex Design Studio",
    reason: "owner_must_leave",
  },
];

if (state === "pending")
  showPendingDeletion({ deleteAfter: "2026-12-09T10:00:00.000Z" });

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.origin).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === ME_PATH)
    return meResponse({
      user: {
        id: "dana",
        email: "dana@acme.test",
        name: "Dana Whitfield",
        role: "owner",
      },
    });
  if (path === `${ME_PATH}/instructions`)
    return Response.json({ instructions: "" });
  if (path === `${ME_PATH}/preferences`)
    return Response.json({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      dismissedNotices: [],
      noticesDue: [],
      narration: null,
      skin: "openbot",
      proactive: "on",
    });
  if (path === "/api/v2/people/me/organizations") return Response.json(MINE);
  if (path === "/api/v2/people/me/account-deletion" && method === "GET")
    return Response.json(
      state === "pending"
        ? {
            status: "scheduled",
            requestedAt: "2026-11-25T10:00:00.000Z",
            deleteAfter: "2026-12-09T10:00:00.000Z",
            blockers: [],
          }
        : { status: "none", blockers: state === "blockers" ? BLOCKERS : [] },
    );
  if (path === "/api/v2/people/me/account-deletion" && method === "POST")
    return Response.json(
      {
        type: "https://open.bot/errors/reauthenticate",
        title: "Sign in again.",
        status: 403,
        detail: "To delete your account, sign in again first.",
        code: "REAUTHENTICATE",
        category: "auth",
        retryable: false,
        requestId: "req_example",
        traceId: "trace_example",
      },
      {
        status: 403,
        headers: { "content-type": "application/problem+json" },
      },
    );
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const General = GeneralRoute.options.component as ComponentType;
const rootRoute = createRootRoute({
  component: () => (
    <div className="bg-background text-foreground">
      <ThemeProvider>
        <PendingDeletionGate>
          <div className="flex h-svh flex-col">
            <General />
          </div>
        </PendingDeletionGate>
      </ThemeProvider>
    </div>
  ),
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
