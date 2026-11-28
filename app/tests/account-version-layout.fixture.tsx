import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
  AccountMenu,
  AccountRow,
} from "@/components/app-sidebar/account-label";
import {
  DropdownMenuContent,
  DropdownMenuItem,
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
 * The account row as the account menu draws it, as a page of its own for
 * account-version-layout.test.tsx to bundle and load in a browser: the real row, `?width=<px>`
 * wide, and under it the strip's avatar that opens the menu. The person is `?name=` and the server's
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
        <SidebarProvider>
          <div className="flex flex-col gap-2 p-2">
            {/* The row as the account menu draws it, held to `width`. */}
            <div className="bg-popover" style={{ width }}>
              <AccountRow />
            </div>
            {/* The strip's avatar, which opens the menu. */}
            <div className="bg-sidebar">
              <AccountMenu>
                <DropdownMenuContent align="start" side="right" sideOffset={8}>
                  <DropdownMenuItem>Settings</DropdownMenuItem>
                </DropdownMenuContent>
              </AccountMenu>
            </div>
          </div>
        </SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
