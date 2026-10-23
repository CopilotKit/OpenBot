import {
  IconArrowLeft,
  IconBell,
  IconChecks,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconSettings,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { desktopShell } from "@/lib/desktop/intelligence-dashboard";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const ITEMS: {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  /** Shown only inside OpenBot Desktop, which is what the page reads from. */
  desktopOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
}[] = [
  {
    title: "General",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /* Where updates go for every Bot at once; how much each Bot sends is on that Bot's page. */
    title: "Notifications",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    /* Whether Bots ask first, and rules for every Bot. Team settings are an administrator's. */
    title: "Approvals",
    icon: IconChecks,
    linkOptions: { to: "/settings/approvals" },
  },
  {
    /* Logins saved from a Bot's private sign-in form. */
    title: "Passwords",
    icon: IconKey,
    linkOptions: { to: "/settings/passwords" },
  },
  {
    /* What OpenBot runs here and the memory it takes, with Restart and Stop. */
    title: "This computer",
    icon: IconDeviceDesktop,
    desktopOnly: true,
    linkOptions: { to: "/settings/computer" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "Components gallery",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/* Matched to the app sidebar's header, as Admin's is. See admin-sidebar.tsx. */}
      <SidebarHeader className="h-12 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  <IconArrowLeft className="mr-2 h-4 w-4" />
                  Back to app
                </Link>
              )}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/*
         * Group outside menu, as Admin has it. The other way round nests a list item inside a div
         * inside the `ul`, which is not markup a list is allowed to be made of.
         */}
        <SidebarGroup>
          <SidebarMenu className="gap-px">
            {ITEMS.filter(
              (option) => !option.desktopOnly || desktopShell() !== null,
            ).map((option) => (
              <SidebarMenuItem key={option.title}>
                <SidebarMenuButton
                  render={(props) => (
                    <Link
                      {...option.linkOptions}
                      activeOptions={{ exact: option.exact ?? false }}
                      activeProps={{ className: "bg-foreground/5" }}
                      {...props}
                    >
                      <option.icon className="mr-2 h-4 w-4" />
                      {option.title}
                    </Link>
                  )}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
