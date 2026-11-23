import { NOTICE_ID_PATTERN } from "@openbot/shared/notices";
import type { Import, ReconnectApp } from "@/lib/api/generated/model";

/**
 * THE APPS A MOVE TO OPENBOT CLOUD LEFT FOR THE PERSON TO CONNECT AGAIN, AND THE RULES FOR WHEN ONE
 * STOPS ASKING.
 *
 * A move carries every connection as its app and account name only: the sign-in stays private on the
 * person's computer, so each app is listed in the import's `reconnect` and connected again here. An
 * app stops asking once the person's own connections have it, or once they dismiss it. Both are read
 * from the server (their connections, and `dismissedNotices` in their preferences), so the list is
 * the same after a reload and on every device.
 */

/** The longest notice id the server keeps: `NoticeId` in api/openapi/common.yaml. */
const NOTICE_ID_MAX = 64;
const PREFIX = "moved-app-";

/** FNV-1a, 32 bits, as 8 hex digits: the same on every device, for the same app id. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The notice id that records a moved app as dismissed: `moved-app-<slug>`, where the slug is the app
 * id lowercased with every run of other characters made one hyphen and none at either end. It fits
 * the server's `NoticeId` (lowercase words joined by single hyphens, at most 64 characters).
 *
 * An id too long for that, or with nothing left of it once cleaned (an id in another script), keeps
 * as much of the slug as fits and ends in a hash of the whole app id. Cutting alone would give two
 * long ids that share a beginning one notice, and dismissing one would dismiss both.
 */
export function movedAppNoticeId(appId: string): string {
  const slug = appId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const room = NOTICE_ID_MAX - PREFIX.length;
  if (slug.length > 0 && slug.length <= room) return `${PREFIX}${slug}`;
  const tag = shortHash(appId);
  const head = slug.slice(0, room - tag.length - 1).replace(/-+$/, "");
  return head ? `${PREFIX}${head}-${tag}` : `${PREFIX}${tag}`;
}

/** Whether a notice id is one the server accepts. The rule above always makes one; this proves it. */
export function isNoticeId(id: string): boolean {
  return id.length <= NOTICE_ID_MAX && NOTICE_ID_PATTERN.test(id);
}

/**
 * Every app the person's finished moves listed to connect again, once each, newest move first.
 *
 * EVERY FINISHED MOVE, NOT ONLY THE NEWEST. A person can move more than once (a second computer, or
 * a move run again), and an app the first move listed still needs connecting after the second one.
 * The same app listed by two moves is one app to connect, so the newest move's entry is kept: its
 * account name and Bots are the latest. Only `imported` moves count: one still under way, or one
 * that failed, has not moved anything the person would miss.
 */
export function movedApps(imports: readonly Import[]): ReconnectApp[] {
  const seen = new Set<string>();
  const apps: ReconnectApp[] = [];
  for (const move of imports) {
    if (move.status !== "imported") continue;
    for (const app of move.reconnect ?? []) {
      if (seen.has(app.appId)) continue;
      seen.add(app.appId);
      apps.push(app);
    }
  }
  return apps;
}

/**
 * The app here that a moved app is, from the organization's apps (listApps), or undefined when the
 * organization hasn't added it.
 *
 * A MOVE NAMES AN APP AS THE COMPUTER KNEW IT, NOT AS IT IS HERE. An app from the directory travels
 * as its directory slug (`gmail`), and here it is the app added from the entry `directory:gmail`,
 * whose id is OpenBot Cloud's own (`composio-gmail`): its page, and the person's connections to it,
 * go by that id. Any other app (a catalogue app, a server added by its address) travels as its id.
 */
export function cloudAppFor<
  T extends { id: string; directoryEntryId: string | null },
>(appId: string, apps: readonly T[]): T | undefined {
  return (
    apps.find((app) => app.directoryEntryId === `directory:${appId}`) ??
    apps.find((app) => app.id === appId)
  );
}

/**
 * One moved app as the screens draw it: its notice id, the id of the app it is here (null where the
 * organization hasn't added it), and whether the person has connected it again.
 */
export type MovedApp = ReconnectApp & {
  noticeId: string;
  cloudId: string | null;
  reconnected: boolean;
};

/**
 * The moved apps still in view: every one the person has not dismissed, each marked reconnected
 * when their own connections have the app it is here. `cloudIdOf` names that app (`cloudAppFor`),
 * and `connected` is the app ids of the person's own live connections.
 */
export function movedAppsInView(
  apps: readonly ReconnectApp[],
  cloudIdOf: (appId: string) => string | undefined,
  connected: ReadonlySet<string>,
  dismissed: readonly string[],
): MovedApp[] {
  const answered = new Set(dismissed);
  return apps
    .map((app) => {
      const cloudId = cloudIdOf(app.appId) ?? null;
      return {
        ...app,
        noticeId: movedAppNoticeId(app.appId),
        cloudId,
        reconnected: cloudId !== null && connected.has(cloudId),
      };
    })
    .filter((app) => !answered.has(app.noticeId));
}

/** "Research", "Research and Inbox", "Research, Inbox and Sales". */
export function botList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Whether a page is the list of apps to reconnect (`/reconnect`, `/reconnect/<app>`), which is part
 * of Connections in every frame, as each app's page it opens is.
 */
export function underConnections(pathname: string): boolean {
  return pathname === "/reconnect" || pathname.startsWith("/reconnect/");
}

/** How many moved apps still need connecting, as a person reads it. */
export function stillToReconnect(count: number): string {
  return count === 1
    ? "1 app from your move still needs reconnecting"
    : `${count} apps from your move still need reconnecting`;
}
