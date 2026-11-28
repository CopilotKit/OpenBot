import {
  type AppFrameConfig,
  type AppScene,
  SIDEBAR_STORAGE_KEY,
  SKIN_STORAGE_KEY,
} from "./appContract";
import type { WorkbenchState } from "./urlState";

/**
 * What one app frame starts with: the scene's own values, and the link's values on top. The frame
 * reads it from `window.parent.__workbenchAppFrame`.
 *
 * The skin and the sidebar go into the frame's storage, where the app reads them before its first
 * paint (`openbot-skin`, `openbot-sidebar`); the skin also answers the person's preferences
 * (app/workbench/frameBoot.ts), since the account's skin wins over the stored one.
 */
export function appFrameConfig(
  state: WorkbenchState,
  scene: AppScene,
): AppFrameConfig {
  const skin = state.app?.skin ?? scene.start.skin ?? null;
  const sidebar = state.app?.sidebar ?? scene.start.sidebar ?? null;
  return {
    scene: scene.id,
    host: state.app?.host ?? scene.start.host,
    os: state.window.os,
    theme: state.window.theme,
    role: state.app?.role ?? null,
    skin,
    sidebar,
    api: state.api ?? {},
    answers: state.answers,
    storage: {
      ...(scene.start.storage ?? {}),
      ...(skin !== null ? { [SKIN_STORAGE_KEY]: skin } : {}),
      ...(sidebar !== null
        ? {
            [SIDEBAR_STORAGE_KEY]:
              sidebar === "open" ? "expanded" : "collapsed",
          }
        : {}),
    },
  };
}
