import { IconLogout, IconSettings } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import {
  AccountMenu,
  AccountRow,
  accountMenuClassName,
  accountMenuItemClassName,
} from "@/components/app-sidebar/account-label";
import { Strip } from "@/components/layout/strip";
import { OrganizationMenuItems } from "@/components/organizations/organization-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type AuthenticatedUser,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import {
  type DeploymentCapabilities,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import {
  type OwnOrganizations,
  ownOrganizationsQueryOptions,
} from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";

/**
 * The account menu as the sidebar's strip opens it, as a page of its own for
 * organization-menu-names.test.tsx to bundle and load in a browser: the strip at the window's left
 * edge with the account's avatar at its foot, and the menu it opens to its right, with the real
 * account row, the real organization rows and the menu's own spacing (`StripAccount` in
 * components/app-sidebar/section-strip.tsx). The person works in "Acme", their own organization is
 * `?organization=<name>` below it, and each `?also=<name>` is one more they share.
 */
const params = new URLSearchParams(location.search);
const own = params.get("organization") ?? "Sam Rivera's organization";
const shared = params.getAll("also");

setCurrentOrganization("org_acme");
queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
} satisfies DeploymentCapabilities);
queryClient.setQueryData(ownOrganizationsQueryOptions().queryKey, {
  organizations: [
    { id: "org_acme", slug: "acme", name: "Acme", personal: false },
    { id: "org_own", slug: "own", name: own, personal: true },
    ...shared.map((name, index) => ({
      id: `org_${index}`,
      slug: `shared-${index}`,
      name,
      personal: false,
    })),
  ].map((organization) => ({ ...organization, role: "owner", active: true })),
  canCreate: true,
  currentId: "org_acme",
} as OwnOrganizations);
queryClient.setQueryData(currentUserQueryOptions().queryKey, {
  id: "person",
  email: "sam@example.com",
  name: "Sam Rivera",
  role: "admin",
  onboarding: null,
  openbotVersion: "v1.0.2",
} as AuthenticatedUser);

function StripWithAccount() {
  return (
    <TooltipProvider>
      <SidebarProvider className="min-h-svh bg-sidebar">
        <Strip
          // The window's height, so the account sits at its foot as it does in the app.
          className="h-svh"
          footer={
            <AccountMenu>
              <DropdownMenuContent
                align="end"
                className={accountMenuClassName}
                side="right"
                sideOffset={8}
              >
                <AccountRow />
                <DropdownMenuSeparator />
                <OrganizationMenuItems
                  choices={
                    queryClient.getQueryData(
                      ownOrganizationsQueryOptions().queryKey,
                    ) as OwnOrganizations
                  }
                  invitationsWaiting={0}
                  itemClassName={accountMenuItemClassName}
                  onNew={() => {}}
                  switching={{ pending: false, run: () => {} }}
                />
                <DropdownMenuItem className={accountMenuItemClassName}>
                  <IconSettings />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={accountMenuItemClassName}
                  variant="destructive"
                >
                  <IconLogout />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </AccountMenu>
          }
        >
          {null}
        </Strip>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: StripWithAccount }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
