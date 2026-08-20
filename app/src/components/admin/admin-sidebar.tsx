import {
  IconArrowLeft,
  IconCode,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPlugConnected,
  IconPuzzle,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;

/**
 * The same three groups, in the same order, as the admin index.
 *
 * A rail that lists eight things flat asks somebody to know which of them is the one they want. The
 * grouping is the only navigation help this screen offers, so it has to agree with the page it
 * navigates to — two different orderings of the same eight links is worse than either ordering.
 */
const GROUPS: {
  label: string;
  items: {
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    label: "What Bots can reach",
    items: [
      {
        title: "Connectors",
        icon: IconPlugConnected,
        linkOptions: { to: "/admin/connectors" },
      },
      {
        title: "Credentials",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "Boundaries",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "Computers",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    label: "What Bots can do",
    items: [
      {
        title: "Plugins",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "UI Components",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "Playground",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    label: "What happened",
    items: [
      {
        title: "Audit",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

export function AdminSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      {/*
       * Pinned to the same height as the app sidebar's header. Left to itself this one is 60px
       * against the app's 45px — `p-2` around a `size="lg"` button rather than a fixed height — so
       * the nav list started lower here and the sidebar appeared to shift on the way into Admin.
       *
       * The button takes its default height rather than `h-full`. `h-full` resolves against the
       * parent, which in the app sidebar is a flex row holding a second control and here is not, so
       * the same class produces two different heights.
       */}
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
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
               * `activeOptions.exact`, because /admin is a prefix of every other route here and
               * would otherwise light up on all of them.
               */}
              <SidebarMenuButton
                render={(props) => (
                  <Link
                    {...adminLinkOptions}
                    activeOptions={{ exact: true }}
                    activeProps={{ className: "bg-foreground/5" }}
                    {...props}
                  >
                    Overview
                  </Link>
                )}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    render={(props) => (
                      <Link
                        {...item.linkOptions}
                        activeProps={{ className: "bg-foreground/5" }}
                        {...props}
                      >
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
