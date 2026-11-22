/*
 * Where the workbench goes when one window hands over to the other. After a desktop scene that
 * ends with the app open, it shows an app scene. After an app button that hands back to the
 * desktop app (a "handback" command), it shows the desktop scene that the window shows next.
 */

/** The app scene after a desktop scene that installs OpenBot on this computer. */
export const APP_SCENE_AFTER_INSTALL = "app-onboarding";

/** The app scene after a desktop scene that connects to an OpenBot somewhere else. */
export const APP_SCENE_AFTER_CONNECT = "app-home-bots";

/** Gives the id of the app scene that follows the desktop scene `desktopSceneId`. */
export function appSceneAfter(desktopSceneId: string): string {
  return desktopSceneId.includes("connect") &&
    !desktopSceneId.includes("install")
    ? APP_SCENE_AFTER_CONNECT
    : APP_SCENE_AFTER_INSTALL;
}

/**
 * For each handback command, the desktop scene that shows the screen the window goes to, or
 * null when no scene shows that screen.
 */
export const HANDBACK_SCENES: Readonly<Record<string, string | null>> = {
  // Setup at the move, with OpenBot still running here.
  "plugin:openbot-desktop|move_to_cloud": "move-to-cloud",
  // Setup at its AI screen: no scene opens there (`take_ai_connection_change` is always false).
  "plugin:openbot-desktop|change_ai_connection": null,
  // Setup with Start.
  "plugin:openbot-desktop|stop": "state-start",
  // Setup at its first screen, where the connect form is (no scene has the address still filled in).
  "plugin:openbot-desktop|sign_out": "state-first-run",
  // Setup at its first screen: the choice of where OpenBot runs.
  "plugin:openbot-desktop|change_connection": "state-first-run",
};

/** Gives the desktop scene that follows the handback command `command`, or null. */
export function desktopSceneFor(command: string): string | null {
  return Object.hasOwn(HANDBACK_SCENES, command)
    ? (HANDBACK_SCENES[command] ?? null)
    : null;
}

/** What each handback command does, in words for the handback card. */
export const HANDBACK_WORDS: Readonly<Record<string, string>> = {
  "plugin:openbot-desktop|move_to_cloud": "move to OpenBot Cloud",
  "plugin:openbot-desktop|change_ai_connection": "change the AI connection",
  "plugin:openbot-desktop|stop": "stop OpenBot",
  "plugin:openbot-desktop|sign_out": "sign out",
  "plugin:openbot-desktop|change_connection":
    "go back to OpenBot on this computer",
};
