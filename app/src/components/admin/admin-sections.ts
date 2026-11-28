import {
  IconBrain,
  IconBuildingBank,
  IconBulb,
  IconCloudCog,
  IconCode,
  IconLayoutGrid,
  IconLockAccess,
  IconShieldCheck,
  IconUsers,
  IconUsersGroup,
  IconZoomQuestion,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { AI_PROVIDERS_TITLE } from "@/lib/ai-connection/paths";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { managePaths } from "@/lib/manage-paths";
import { MANAGEMENT_SENTENCE } from "@/lib/management/format";
import {
  asksForManagement,
  managementQueryOptions,
} from "@/lib/management/queries";
import { primitive, VAULT } from "@/lib/primitives";

export type AdminEntry = {
  title: string;
  /** What the Admin overview says the page is for. The sidebar shows the title alone. */
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  linkOptions: LinkOptions;
};

export type AdminSection = { title: string; items: AdminEntry[] };

const team = managePaths("team");

/** The Admin page where an organization sets up its own company sign-in. */
export const IDENTITY_PROVIDERS_PATH = "/admin/identity-providers";

/**
 * Admin's pages, grouped by the thing a Bot has that each one sets for everybody, in the fixed order
 * of `lib/primitives.ts`, then Vault, then the organization itself: its people and the teams they are
 * in, what they may do, and how they sign in. The sidebar and the overview both draw
 * this list, so the two can never disagree about where a page is.
 *
 * Conversations has no group: it is where work happens, not something to set. Memory has none
 * either, because there is nothing about it for an admin to set. Pages keep their addresses.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    title: primitive("routines").label,
    items: [
      {
        title: primitive("routines").label,
        description:
          "Turn check-ins on or off, limit them, and see how often people start what Bots raise.",
        icon: primitive("routines").icon,
        linkOptions: { to: "/admin/proactive" },
      },
    ],
  },
  {
    title: primitive("skills").label,
    items: [
      {
        title: primitive("skills").label,
        description: "Create reusable instructions people can run with /.",
        icon: primitive("skills").icon,
        linkOptions: team.skills(),
      },
      {
        title: "Automatic learning",
        description:
          "Learn from finished conversations, review the skills it proposes, and choose whether people may share theirs.",
        icon: IconBulb,
        linkOptions: { to: "/admin/learning" },
      },
    ],
  },
  {
    title: primitive("apps").label,
    items: [
      {
        title: team.pluginsLabel,
        description:
          "Connect services, choose which Bots can use them, and approve connectors.",
        icon: primitive("apps").icon,
        linkOptions: team.plugins(),
      },
      {
        title: "UI components",
        description:
          "Manage custom components that Bots can display in conversations.",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "Playground",
        description: "Write a component and watch it render as you type.",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: primitive("computer").label,
    items: [
      {
        title: "Computers",
        description:
          "Manage the computers that run Bot tools, when idle ones stop, and where they can connect.",
        icon: primitive("computer").icon,
        linkOptions: team.computers(),
      },
    ],
  },
  {
    title: primitive("approvals").label,
    items: [
      {
        title: primitive("approvals").label,
        description: "Choose which actions require approval for members’ Bots.",
        icon: primitive("approvals").icon,
        linkOptions: { to: "/admin/approvals" },
      },
      {
        title: "Boundaries",
        description: "Define actions that no Bot may take.",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        /* Which of the two above, or Permissions, decides an action: they are what it asks about. */
        title: "What would happen",
        description:
          "Ask what OpenBot would do if a Bot took an action, and see which control decides.",
        icon: IconZoomQuestion,
        linkOptions: { to: "/admin/what-if" },
      },
    ],
  },
  {
    title: primitive("activity").label,
    items: [
      {
        title: team.auditLabel,
        description:
          "Review actions taken in OpenBot and who took them, and record Bots' commands.",
        icon: primitive("activity").icon,
        linkOptions: team.audit(),
      },
    ],
  },
  {
    title: VAULT.label,
    items: [
      {
        title: team.credentialsLabel,
        description: "Manage this organization’s keys and tokens.",
        icon: VAULT.icon,
        linkOptions: team.credentials(),
      },
    ],
  },
  {
    title: "Organization",
    items: [
      {
        title: "People",
        description: "Review members, manage admin roles, and remove access.",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "Teams",
        description: "Put people in teams, and give a team its own Bots.",
        icon: IconUsersGroup,
        /*
         * The page everybody opens at /teams, drawn here in Admin's frame so Admin stays open. An
         * admin does on it what the server lets an admin do, in either place.
         */
        linkOptions: { to: "/admin/teams" },
      },
      {
        title: "Permissions",
        description:
          "Choose what people may do with Bots, for everybody and per role or group.",
        icon: IconLockAccess,
        linkOptions: { to: "/admin/permissions" },
      },
      {
        title: "Identity providers",
        description:
          "Configure your company’s sign-in provider for each email domain, and require SSO.",
        icon: IconBuildingBank,
        linkOptions: { to: IDENTITY_PROVIDERS_PATH },
      },
      {
        title: AI_PROVIDERS_TITLE,
        description:
          "See which provider serves your Bots' models, and choose which models they may use.",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
    ],
  },
];

/**
^ * Managed updates: connecting a self-hosted OpenBot to CopilotKit's management service. Not in
 * {@link ADMIN_SECTIONS}, because it applies only where the server says so (the team edition a
 * company runs itself, in the organization `default`); {@link adminSections} adds it there.
 */
export const MANAGEMENT_ENTRY: AdminEntry = {
  title: "Managed updates",
  description: MANAGEMENT_SENTENCE,
  icon: IconCloudCog,
  linkOptions: { to: "/admin/management" },
};

/**
 * Admin's pages, with Managed updates at the end of the organization's when it applies, and without
 * Identity providers on OpenBot by CopilotKit (`hostedSignIn`): people sign in there with their
 * CopilotKit account, so an organization has no identity provider of its own to set up.
 */
export function adminSections(
  management: boolean,
  hosted = false,
): readonly AdminSection[] {
  if (!management && !hosted) return ADMIN_SECTIONS;
  return ADMIN_SECTIONS.map((section) => {
    if (section.title !== "Organization") return section;
    const items = hosted
      ? section.items.filter(
          (item) =>
            (item.linkOptions as { to?: string }).to !==
            IDENTITY_PROVIDERS_PATH,
        )
      : section.items;
    return {
      ...section,
      items: management ? [...items, MANAGEMENT_ENTRY] : items,
    };
  });
}

/**
 * The sections the rail and the overview draw. Management is left out while its answer is loading
 * or failed, and wherever the server answers that it doesn't apply. Identity providers is left out
 * where the server says people sign in through OpenBot by CopilotKit; Admin's route has read that
 * answer before any of its pages draws (`admin/route.tsx`).
 */
export function useAdminSections(): readonly AdminSection[] {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const asks = asksForManagement(capabilities);
  const management = useQuery({ ...managementQueryOptions(), enabled: asks });
  return adminSections(
    asks && management.data?.applies === true,
    capabilities.data?.hostedSignIn === true,
  );
}
