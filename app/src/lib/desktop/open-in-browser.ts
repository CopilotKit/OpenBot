import { desktopShell } from "./shell";

/**
 * Open an address in the person's own browser from the OpenBot Desktop window, answering whether it
 * was handed over. The window is a webview, so a link to one of OpenBot's own pages would open
 * inside it; this is the opener plugin's command, which leaves the window where it is. False in a
 * plain browser, and when the window refuses the command.
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  const shell = desktopShell();
  if (!shell) return false;
  try {
    await shell.invoke("plugin:opener|open_url", { url });
    return true;
  } catch {
    return false;
  }
}
