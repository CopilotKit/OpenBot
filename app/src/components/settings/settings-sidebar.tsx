import {
  IconArrowLeft,
  IconBell,
  IconLayoutGrid,
  IconListCheck,
  IconSettings,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
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
import { managePaths } from "@/lib/manage-paths";
import { primitive, VAULT } from "@/lib/primitives";
import { mayOpenSetup, setupChecklistQueryOptions } from "@/lib/setup/queries";

const appLinkOptions = { to: "/" } satisfies LinkOptions;

export type SettingsGroup = "you" | "every-bot" | "openbot";

/** The sidebar's three groups, in order, and what each is called. */
export const SETTINGS_GROUPS: readonly { id: SettingsGroup; label: string }[] =
  [
    { id: "you", label: "You" },
    { id: "every-bot", label: "Every Bot" },
    { id: "openbot", label: "OpenBot" },
  ];

type SettingsSidebarItem = {
  group: SettingsGroup;
  /**
   * Whether this entry lights only on its own route.
   *
   * On for an entry whose path is a prefix of another's, which is the only reason to want it. Off
   * everywhere else, so an entry stays lit on the pages beneath it.
   */
  exact?: boolean;
  /** Shown only where OpenBot offers memory (see `offersMemory`). */
  memoryOnly?: boolean;
  /** Shown only in the personal edition. */
  personalOnly?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
  title: string;
  setup?: boolean;
};

/**
 * Settings, for every Bot at once (`docs/how-openbot-works.md`), in three groups:
 *
 * - You: your account, where updates reach you, and your Vault.
 * - Every Bot: the things a Bot has, set for all of them, in the fixed order of `lib/primitives.ts`.
 *   Conversations is not here: it is where work happens, not something to set. Apps are on
 *   Connections, in the main menu.
 * - OpenBot: what OpenBot itself has and needs, and the gallery of what a Bot can draw.
 *
 * An entry with nothing to set in this edition is left out: Memory where OpenBot offers none, and
 * Activity in the team edition, where the trail is an admin's (Admin → Activity).
 */
export const SETTINGS_SIDEBAR_ITEMS: SettingsSidebarItem[] = [
  {
    group: "you",
    title: "General",
    icon: IconSettings,
    /* `/settings` prefixes every other route here, and would otherwise light up on all of them. */
    exact: true,
    linkOptions: { to: "/settings" },
  },
  {
    /* Where updates go for every Bot at once; how much each Bot sends is on that Bot's page. */
    group: "you",
    title: "Notifications",
    icon: IconBell,
    linkOptions: { to: "/settings/notifications" },
  },
  {
    /* Your saved logins and, in the personal edition, your keys. No Bot sees what is in it. */
    group: "you",
    title: VAULT.label,
    icon: VAULT.icon,
    linkOptions: { to: "/settings/vault" },
  },
  {
    /* Every Bot's routines, goals and check-ins in one list, and the switch for all check-ins. */
    group: "every-bot",
    title: primitive("routines").label,
    icon: primitive("routines").icon,
    linkOptions: { to: "/settings/routines" },
  },
  {
    group: "every-bot",
    title: primitive("memory").label,
    icon: primitive("memory").icon,
    memoryOnly: true,
    linkOptions: { to: "/settings/memory" },
  },
  {
    /* The skills that are yours, written, taught or learned, and what waits for your review. */
    group: "every-bot",
    title: primitive("skills").label,
    icon: primitive("skills").icon,
    linkOptions: { to: "/settings/skills" },
  },
  {
    /* The computer Bots work on, folders, what OpenBot runs here, and your Recorder browsers. */
    group: "every-bot",
    title: primitive("computer").label,
    icon: primitive("computer").icon,
    linkOptions: { to: "/settings/computer" },
  },
  {
    /* Whether Bots ask first, and rules for every Bot. Team settings are an admin's. */
    group: "every-bot",
    title: primitive("approvals").label,
    icon: primitive("approvals").icon,
    linkOptions: { to: "/settings/approvals" },
  },
  {
    group: "every-bot",
    title: managePaths("personal").auditLabel,
    icon: primitive("activity").icon,
    personalOnly: true,
    linkOptions: { to: "/settings/activity" },
  },
  {
    /* What the deployment has and still needs: onboarding's checklist, to come back to. */
    group: "openbot",
    title: "Setup",
    icon: IconListCheck,
    linkOptions: { to: "/settings/setup" },
    setup: true,
  },
  {
    /* The same mark Admin gives UI Components. It is the same subject seen from the other side. */
    group: "openbot",
    title: "Components gallery",
    icon: IconLayoutGrid,
    linkOptions: { to: "/settings/components-gallery" },
  },
];

/** The entries this edition has, in order. Setup is narrowed further by who may open it. */
export function settingsSidebarItems(
  edition: "team" | "personal",
): SettingsSidebarItem[] {
  return SETTINGS_SIDEBAR_ITEMS.filter(
    (item) =>
      (!item.personalOnly || edition === "personal") &&
      (!item.memoryOnly || offersMemory({ edition })),
  );
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
  const items = settingsSidebarItems(capabilities?.edition ?? "team").filter(
    (option) => !option.setup || canSetUp,
  );
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
        {SETTINGS_GROUPS.map((group) => {
          const entries = items.filter((option) => option.group === group.id);
          if (entries.length === 0) return null;
          return (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu className="gap-px">
                {entries.map((option) => (
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
          );
        })}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
