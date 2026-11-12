import {
  IconBrain,
  IconBuildingBank,
  IconBulb,
  IconCode,
  IconLayoutGrid,
  IconLockAccess,
  IconShieldCheck,
  IconUsers,
  IconZoomQuestion,
} from "@tabler/icons-react";
import type { LinkOptions } from "@tanstack/react-router";
import type * as React from "react";
import { managePaths } from "@/lib/manage-paths";
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

/**
 * Admin's pages, grouped by the thing a Bot has that each one sets for everybody, in the fixed order
 * of `lib/primitives.ts`, then Vault, then the team itself. The sidebar and the overview both draw
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
          "Connect services, choose which Bots can use them, and approve MCP servers.",
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
        description: "Manage this deployment’s keys and tokens.",
        icon: VAULT.icon,
        linkOptions: team.credentials(),
      },
    ],
  },
  {
    title: "Team",
    items: [
      {
        title: "People",
        description: "Review members, manage admin roles, and remove access.",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
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
        linkOptions: { to: "/admin/identity-providers" },
      },
      {
        title: "Providers",
        description:
          "See which provider serves your Bots' models, and choose which models they may use.",
        icon: IconBrain,
        linkOptions: { to: "/admin/providers" },
      },
    ],
  },
];
