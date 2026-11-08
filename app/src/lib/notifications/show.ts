import { desktopShell } from "@/lib/desktop/shell";

/** A notification OpenBot raises, and the page of OpenBot a click on it opens. */
export type Notice = {
  title: string;
  body: string;
  /** Two tabs raising the same notice show it once. */
  tag: string;
  /** An OpenBot path: `/channel/c-1`, `/bots/expenses`. */
  path: string;
  /** In a browser, what a click does. OpenBot Desktop opens `path` itself. */
  onClick?: () => void;
};

/**
 * Raises `notice`, if notifications may be shown (the caller asks `notificationsAllowed` first).
 *
 * IN OPENBOT DESKTOP the desktop app shows it (`notify`, desktop/src-tauri/src/notice.rs). On
 * Windows only a toast it builds can bring OpenBot back at `path` from the notification centre: an
 * app installed without a package has to be opened by a link there, which the notification plugin's
 * toasts cannot carry. A desktop app from before that command shows it through the plugin, whose
 * script stands in for `Notification`, with the page in `extra.path`.
 */
export function showNotice(notice: Notice): void {
  const shell = desktopShell();
  if (!shell) {
    browserNotice(notice);
    return;
  }
  shell
    .invoke("plugin:openbot-desktop|notify", {
      title: notice.title,
      body: notice.body,
      path: notice.path,
    })
    .catch(() => browserNotice(notice));
}

function browserNotice(notice: Notice) {
  const options: NotificationOptions & { extra: { path: string } } = {
    body: notice.body,
    tag: notice.tag,
    extra: { path: notice.path },
  };
  try {
    const shown = new Notification(notice.title, options);
    if (notice.onClick) {
      const open = notice.onClick;
      shown.onclick = () => {
        window.focus();
        open();
        shown.close?.();
      };
    }
  } catch {
    // A browser that refuses the constructor still has the badge.
  }
}
