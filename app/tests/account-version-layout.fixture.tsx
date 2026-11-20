import { QueryClientProvider } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AccountMenu } from "@/components/app-sidebar/account-label";
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
 * The default sidebar's account row, as a page of its own for account-version-layout.test.tsx to
 * bundle and load in a browser: the real row in the real sidebar parts, with the gutter the app's
 * sidebar shell adds, in a sidebar `?width=<px>` wide. The person is `?name=` and the server's
 * release `?version=`. With `?organization=<name>` the person works in an organization of that name,
 * on an OpenBot that lists them, as the account row reads it under their name.
 */
const params = new URLSearchParams(location.search);
const width = Number(params.get("width") ?? 340);
const organization = params.get("organization");

if (organization) {
  // Known before anything is kept, as the signed-in gate leaves it: each answer is kept under it.
  setCurrentOrganization("org_row");
  queryClient.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
  } satisfies DeploymentCapabilities);
  queryClient.setQueryData(ownOrganizationsQueryOptions().queryKey, {
    organizations: [
      {
        id: "org_row",
        slug: "row",
        name: organization,
        role: "owner",
        active: true,
      },
    ],
    canCreate: true,
    currentId: "org_row",
  } as OwnOrganizations);
}

queryClient.setQueryData(currentUserQueryOptions().queryKey, {
  id: "person",
  email: "person@example.com",
  name: params.get("name") ?? "",
  role: "admin",
  onboarding: null,
  openbotVersion: params.get("version"),
} as AuthenticatedUser);

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider
          className="[&_[data-sidebar=menu-button]]:px-2.5"
          style={{ "--sidebar-width": `${width}px` } as CSSProperties}
        >
          <div className="bg-sidebar" data-sidebar-column="" style={{ width }}>
            <SidebarFooter>
              <SidebarMenu className="gap-px">
                <SidebarMenuItem>
                  <AccountMenu>
                    <DropdownMenuContent
                      align="start"
                      side="top"
                      sideOffset={8}
                    >
                      <DropdownMenuItem>Settings</DropdownMenuItem>
                    </DropdownMenuContent>
                  </AccountMenu>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarFooter>
          </div>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
