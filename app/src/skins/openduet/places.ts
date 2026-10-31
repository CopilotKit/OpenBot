import type { LinkOptions } from "@tanstack/react-router";

/*
 * The skin's own places: its tabs and the column each path gets. Where else a person can go is
 * OpenBot's one navigation list (`lib/navigation.ts`), which the menu draws.
 */

/*
 * Where things are in OpenDuet's frame, as plain data, so the frame, the menu and the tests read
 * one list. Nothing here is a new route: every path is one OpenBot already serves.
 */

/** OpenBot's Tasks: the list, and each task's own page under it. */
export const TASKS_PATH = "/tasks";

export type OpenDuetTab = "chat" | "tasks";

/**
 * Which tab a path belongs to, or null for a page opened over the app.
 *
 * Chat is every conversation OpenBot draws: home, where a conversation starts, a conversation with
 * one Bot or several, and the default Bot's own screen. Tasks is OpenBot's Tasks, the list and every
 * task opened from it. Everything else
 * (Bots, Connections, Skills, Routines and the rest) is a page with a back disc and no tab bar, as
 * OpenDuet opens them.
 */
export function tabForPath(pathname: string): OpenDuetTab | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/bot") return "chat";
  if (/^\/(channel|group)\/[^/]+$/.test(path)) return "chat";
  if (path === TASKS_PATH || path.startsWith(`${TASKS_PATH}/`)) return "tasks";
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

/**
 * How wide the frame's column is. `phone` holds Chat and Tasks to a phone's width. `pane` is a
 * conversation with its Bot's details or computer open: the phone column plus OpenBot's 400px pane
 * beside it (`DetailPanel` lays the pane out beside the conversation once there is room for both).
 * `page` is every other page, at the width OpenBot gave it.
 */
export type OpenDuetColumn = "phone" | "pane" | "page";

export function columnFor(
  pathname: string,
  search: Record<string, unknown> = {},
): OpenDuetColumn {
  const tab = tabForPath(pathname);
  if (!tab) return "page";
  if (tab === "chat" && (search.watch === true || search.settings === true))
    return "pane";
  return "phone";
}

/** The Tasks tab, at OpenBot's Tasks. */
export const TASKS_LINK = { to: TASKS_PATH } satisfies LinkOptions;

/** The conversation a roster row opens: a group has its own shared transcript. */
export function conversationPath(channel: { id: string; agentIds: string[] }) {
  return channel.agentIds.length > 1
    ? (`/group/${channel.id}` as const)
    : (`/channel/${channel.id}` as const);
}
