import { IconLogout, IconSettings } from "@tabler/icons-react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  AccountMenu,
  accountMenuClassName,
  accountMenuItemClassName,
} from "@/components/app-sidebar/account-label";
import { OrganizationMenuItems } from "@/components/organizations/organization-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
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
 * The default sidebar's account menu, as a page of its own for organization-menu-names.test.tsx to
 * bundle and load in a browser: the real account row and the real organization rows, with the
 * menu's own spacing as the sidebar draws it, in a sidebar `?width=<px>` wide. The person works in
 * "Acme", their own organization is `?organization=<name>` below it, and each `?also=<name>` is one
 * more they share.
 */
const params = new URLSearchParams(location.search);
const width = Number(params.get("width") ?? 340);
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

function Footer() {
  return (
    <TooltipProvider>
      <SidebarProvider
        className="[&_[data-sidebar=menu-button]]:px-2.5"
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <div
          className="flex h-svh flex-col justify-end bg-sidebar"
          data-sidebar-column=""
          style={{ width }}
        >
          <SidebarFooter>
            <SidebarMenu className="gap-px">
              <SidebarMenuItem>
                <AccountMenu>
                  <DropdownMenuContent
                    align="start"
                    className={accountMenuClassName}
                    side="top"
                    sideOffset={8}
                  >
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
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute({ component: Footer }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
