import type { AppFrameConfig, AppScene } from "./appContract";
import type { WorkbenchState } from "./urlState";

/**
 * What one app frame starts with: the scene's own values, and the link's values on top. The frame
 * reads it from `window.parent.__workbenchAppFrame`.
 */
export function appFrameConfig(
  state: WorkbenchState,
  scene: AppScene,
): AppFrameConfig {
  return {
    scene: scene.id,
    host: state.app?.host ?? scene.start.host,
    os: state.window.os,
    theme: state.window.theme,
    motion: state.app?.motion ?? "still",
    role: state.app?.role ?? null,
    api: state.api ?? {},
    answers: state.answers,
    storage: scene.start.storage ?? {},
  };
}
