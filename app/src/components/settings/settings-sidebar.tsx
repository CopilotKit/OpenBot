import {
  IconArrowLeft,
  IconBell,
  IconBook,
  IconBrowser,
  IconChecks,
  IconDeviceDesktop,
  IconHistory,
  IconKey,
  IconLayoutGrid,
  IconLock,
  IconPlug,
  IconSchool,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
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
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

type SettingsSidebarItem = {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
};

export const SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
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
    /* The browsers signed in to the Recorder extension as you; each can be disconnected here. */
    title: "Browsers",
    icon: IconBrowser,
    linkOptions: { to: "/settings/browsers" },
  },
  {
    /* Who else's Bots use the Skills learned from your recordings: none, all, or the ones you open. */
    title: "Learning",
    icon: IconSchool,
    linkOptions: { to: "/settings/learning" },
  },
  {
    /* Logins saved from a Bot's private sign-in form. */
    title: "Passwords",
    icon: IconKey,
    linkOptions: { to: "/settings/passwords" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "Components gallery",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

/**
 * What the personal edition keeps of Admin. There is no Admin there, and the one person still adds
 * apps, writes skills for every Bot, stores credentials, resets the computer and reads the trail.
 */
const PERSONAL_SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  { title: "Apps", icon: IconPlug, linkOptions: { to: "/settings/plugins" } },
  {
    title: "Skills for every Bot",
    icon: IconBook,
    linkOptions: { to: "/settings/skills" },
  },
  {
    title: "Credentials",
    icon: IconLock,
    linkOptions: { to: "/settings/credentials" },
  },
  {
    title: "Computer",
    icon: IconDeviceDesktop,
    linkOptions: { to: "/settings/computer" },
  },
  {
    title: "Activity",
    icon: IconHistory,
    linkOptions: { to: "/settings/activity" },
  },
];

export function settingsSidebarItems(
  edition: "team" | "personal",
): SettingsSidebarItem[] {
  return edition === "personal"
    ? [...SETTINGS_SIDEBAR_ITEMS, ...PERSONAL_SETTINGS_SIDEBAR_ITEMS]
    : SETTINGS_SIDEBAR_ITEMS;
}

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { data } = useQuery(deploymentCapabilitiesQueryOptions());
  const items = settingsSidebarItems(data?.edition ?? "team");
  return (
    <Sidebar variant="inset" {...props}>
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
            {items.map((option) => (
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
