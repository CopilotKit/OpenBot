/**
 * A notification's options, with the page it is about. OpenBot Desktop opens that page when the
 * notification is clicked (`open_from_notification` in desktop/src-tauri): there `Notification` is
 * the notification plugin's, which hands `extra` on to the shell. A browser ignores it.
 */
export function noticeOptions(
  options: NotificationOptions,
  path: string,
): NotificationOptions {
  const withPath: NotificationOptions & { extra: { path: string } } = {
    ...options,
    extra: { path },
  };
  return withPath;
}
