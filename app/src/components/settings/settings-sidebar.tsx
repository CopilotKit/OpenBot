import {
  IconArrowLeft,
  IconBell,
  IconBook,
  IconBrowser,
  IconChecks,
  IconClock,
  IconDeviceDesktop,
  IconHistory,
  IconLayoutGrid,
  IconListCheck,
  IconLock,
  IconBrain,
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  deploymentCapabilitiesQueryOptions,
  offersMemory,
} from "@/lib/deployment/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { managePaths } from "@/lib/manage-paths";
import { mayOpenSetup, setupChecklistQueryOptions } from "@/lib/setup/queries";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

type SettingsSidebarItem = {
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  /** Shown only inside OpenBot Desktop, which is what the page reads from. */
  desktopOnly?: boolean;
  /** Shown only where OpenBot offers memory (see `offersMemory`). */
  memoryOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
  setup?: boolean;
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
    /* Every Bot's routines, goals and check-ins in one list, and the switch for all check-ins. */
    title: "Routines",
    icon: IconClock,
    linkOptions: { to: "/settings/routines" },
  },
  {
    /* What your Bots remember about you. Only where OpenBot offers memory. */
    title: "Memory",
    icon: IconBrain,
    memoryOnly: true,
    linkOptions: { to: "/settings/memory" },
  },
  {
    /* The skills that are yours, written, taught or learned, and what waits for your review. */
    title: "Skills",
    icon: IconBook,
    linkOptions: { to: "/settings/skills" },
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
    /* What the deployment has and still needs: onboarding's checklist, to come back to. */
    title: "Setup",
    icon: IconListCheck,
    linkOptions: { to: "/settings/setup" },
    setup: true,
  },
  {
    /* Your saved logins and, in the personal edition, your keys. No Bot sees what is in it. */
    title: "Vault",
    icon: IconLock,
    linkOptions: { to: "/settings/vault" },
  },
  {
    /* What OpenBot runs here and the memory it takes, with Restart and Stop. */
    title: "This computer",
    icon: IconDeviceDesktop,
    desktopOnly: true,
    linkOptions: { to: "/settings/this-computer" },
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    title: "Components gallery",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

/**
 * What the personal edition keeps of Admin. There is no Admin there, and the one person still stores
 * writes skills, resets the computer and reads the trail. Apps are not here: adding one and
 * connecting it are the same step, on Connections, which also links to the Vault.
 */
const PERSONAL_SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    title: "Computer",
    icon: IconDeviceDesktop,
    linkOptions: { to: "/settings/computer" },
  },
  {
    title: managePaths("personal").auditLabel,
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
  const user = useQuery(currentUserQueryOptions()).data;
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions()).data;
  const canSetUp = mayOpenSetup(user, capabilities);
  /*
   * What an admin can act on, counted beside Setup: rows that need setup and say how. Onboarding
   * leaves the checklist out, so this is where an admin learns something is waiting on them. Never
   * asked for anybody else, who could not fix any of it.
   */
  const checklist = useQuery({
    ...setupChecklistQueryOptions(),
    enabled: canSetUp,
  }).data;
  const toFix =
    checklist?.audience === "admin"
      ? checklist.rows.filter(
          (row) => row.status === "needs_setup" && row.fix !== null,
        ).length
      : 0;
  const items = settingsSidebarItems(capabilities?.edition ?? "team");
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
            {items
              .filter(
                (option) =>
                  (!option.setup || canSetUp) &&
                  (!option.desktopOnly || desktopShell() !== null) &&
                  (!option.memoryOnly || offersMemory(capabilities)),
              )
              .map((option) => (
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
                        {option.setup && toFix > 0 ? (
                          <span className="sr-only">
                            , {toFix} {toFix === 1 ? "needs" : "need"} setup
                          </span>
                        ) : null}
                      </Link>
                    )}
                  />
                  {option.setup && toFix > 0 ? (
                    <SidebarMenuBadge aria-hidden="true">
                      {toFix}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
