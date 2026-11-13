import { QueryClientProvider } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { AccountLabel } from "@/components/app-sidebar/account-label";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import {
  type AuthenticatedUser,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import { queryClient } from "@/query-client";

/**
 * The default sidebar's account row, as a page of its own for account-version-layout.test.tsx to
 * bundle and load in Chromium: the real row in the real sidebar parts, with the gutter the app's
 * sidebar shell adds, in a sidebar `?width=<px>` wide. The person is `?name=` and the server's
 * release `?version=`.
 */
const params = new URLSearchParams(location.search);
const width = Number(params.get("width") ?? 340);

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
      <SidebarProvider
        className="[&_[data-sidebar=menu-button]]:px-2.5"
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <div className="bg-sidebar" data-sidebar-column="" style={{ width }}>
          <SidebarFooter>
            <SidebarMenu className="gap-px">
              <SidebarMenuItem>
                <SidebarMenuButton className="hover:bg-foreground/5 h-10">
                  <AccountLabel />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </div>
      </SidebarProvider>
    </QueryClientProvider>,
  );
