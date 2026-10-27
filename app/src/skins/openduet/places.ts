import type { LinkOptions } from "@tanstack/react-router";

/*
 * Where things are in OpenDuet's frame, as plain data, so the frame, the menu and the tests read
 * one list. Nothing here is a new route: every path is one OpenBot already serves, or the skin's own
 * screen at `/s/<key>`.
 */

/** The skin's own screen, served by OpenBot's `/s/$screen`. */
export const TASKS_SCREEN = "tasks";
export const TASKS_PATH = `/s/${TASKS_SCREEN}`;
/** The Tasks section a link can open on, by hash. */
export const RESPONSIBILITIES_HASH = "responsibilities";

export type OpenDuetTab = "chat" | "tasks";

/**
 * Which tab a path belongs to, or null for a page opened over the app.
 *
 * Chat is every conversation OpenBot draws: home, where a conversation starts, a conversation with
 * one Bot or several, and the default Bot's own screen. Tasks is the skin's screen. Everything else
 * (Bots, Connections, Skills, Routines and the rest) is a page with a back disc and no tab bar, as
 * OpenDuet opens them.
 */
export function tabForPath(pathname: string): OpenDuetTab | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/bot") return "chat";
  if (/^\/(channel|group)\/[^/]+$/.test(path)) return "chat";
  if (path === TASKS_PATH) return "tasks";
  return null;
}

/**
 * Whether the screen under the frame is one of the skin's own, which scrolls under the floating
 * header and tab bar by itself. OpenBot's pages own their scrollers, so the frame keeps its chrome
 * clear of them instead.
 */
export function isSkinScreen(pathname: string): boolean {
  return pathname.startsWith("/s/");
}

export type ManagePlace = {
  label: string;
  /** Where the menu row goes. */
  link: LinkOptions;
  /** Only for administrators; the server guards the page either way. */
  adminOnly?: boolean;
};

/**
 * The pages a person sets their Bots up on and comes back to rarely, under Manage in the menu.
 *
 * Each goes where OpenBot serves that thing today. Responsibilities are listed across every Bot on
 * Tasks (each opens its Bot's own page); approval rules and how Bots reach you are in OpenBot's
 * Settings; Skills and Memory are Capabilities' two tabs.
 */
export const MANAGE_PLACES: ManagePlace[] = [
  { label: "Bots", link: { to: "/bots" } },
  { label: "Connections", link: { to: "/connections" } },
  { label: "Skills", link: { to: "/capabilities/skills" } },
  { label: "Memory", link: { to: "/capabilities/memory" } },
  { label: "Routines", link: { to: "/routines" } },
  {
    label: "Responsibilities",
    link: {
      to: "/s/$screen",
      params: { screen: TASKS_SCREEN },
      hash: RESPONSIBILITIES_HASH,
    },
  },
  { label: "Approvals", link: { to: "/settings/approvals" } },
  { label: "Notifications", link: { to: "/settings/notifications" } },
  { label: "Admin", link: { to: "/admin" }, adminOnly: true },
];

/** Settings is never folded away: it holds the skin picker, so a skin can always be switched back. */
export const SETTINGS_LINK = { to: "/settings" } satisfies LinkOptions;
export const TASKS_LINK = {
  to: "/s/$screen",
  params: { screen: TASKS_SCREEN },
} satisfies LinkOptions;

/** The conversation a roster row opens: a group has its own shared transcript. */
export function conversationPath(channel: { id: string; agentIds: string[] }) {
  return channel.agentIds.length > 1
    ? (`/group/${channel.id}` as const)
    : (`/channel/${channel.id}` as const);
}
