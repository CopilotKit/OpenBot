import { IconArrowLeft } from "@tabler/icons-react";
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

const appLinkOptions = { to: "/" } satisfies LinkOptions;

const ITEMS = [
  {
    title: "General",
    linkOptions: { to: "/settings" },
  },
];

export function SettingsSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
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
        <SidebarMenu>
          <SidebarGroup>
            {ITEMS.map((option) => {
              return (
                <SidebarMenuItem key={option.title}>
                  <SidebarMenuButton
                    render={(props) => (
                      <Link
                        {...option.linkOptions}
                        activeProps={{
                          className: "bg-foreground/5",
                        }}
                        {...props}
                      >
                        {option.title}
                      </Link>
                    )}
                  />
                </SidebarMenuItem>
              );
            })}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
