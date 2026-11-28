import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { SignInSection } from "@/components/admin/controls/sign-in-section";
import { deploymentKeys } from "@/lib/deployment/queries";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { organizationKeys } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";
import { Route } from "@/routes/_authed/admin/people";
import { ME_PATH, meResponse, PEOPLE_PATH, personBody } from "./accounts-api";

/**
 * Admin's People page and Identity providers' SCIM row on a self-hosted OpenBot that keeps one
 * shared organization and lets people create more, as a page of its own for
 * admin-people-remove-layout.test.tsx to bundle and load in a browser. `?screen=scim` draws the
 * SCIM row; anything else, People. The server's answers come from a fetch here, as the API gives
 * them, so nothing is asked of a server.
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
const MINE = {
  organizations: [
    {
      id: "default",
      slug: "acme",
      name: "Acme Freight",
      role: "admin",
      personal: false,
      active: true,
    },
  ],
  canCreate: true,
  nextCursor: null,
};
// As the app keeps it: the list, and which of them this window works in.
queryClient.setQueryData(organizationKeys.mine(), {
  ...MINE,
  currentId: "default",
});
queryClient.setQueryData(enterpriseKeys.overview(), {
  settings: { ssoRequired: false },
  scim: {
    configured: true,
    baseUrl: "https://openbot.acme.test/api/auth/scim/v2",
  },
  capabilities: [],
  networkPolicies: [],
});

const dana = {
  id: "dana",
  email: "dana@acme.test",
  name: "Dana Whitfield",
  role: "admin" as const,
};
// A long name and address, which the dialog's title has to give way to on a phone.
const sam = {
  id: "sam",
  email: "samantha.ortiz-villanueva@acme-freight-logistics.example",
  name: "Samantha Ortiz-Villanueva",
  role: "member" as const,
};
const lee = { id: "lee", email: "lee@acme.test", role: "member" as const };

window.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === ME_PATH) return meResponse({ user: dana });
  if (path === "/api/v2/people/me/organizations") return Response.json(MINE);
  if (path === PEOPLE_PATH)
    return Response.json({
      people: [dana, sam, lee].map((one) => ({
        ...personBody(one),
        revoked: false,
      })),
      nextCursor: null,
    });
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const scim = new URLSearchParams(location.search).get("screen") === "scim";
const router = createRouter({
  routeTree: createRootRoute({
    component: scim
      ? () => (
          <div className="h-svh overflow-auto bg-background p-6 text-foreground">
            <SignInSection />
          </div>
        )
      : () => {
          const People = Route.options.component as () => React.JSX.Element;
          return (
            <div className="h-svh overflow-auto bg-background text-foreground">
              <People />
            </div>
          );
        },
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
