import { recorderExtensionIds } from "@openbot/shared/recorder-extension";
import type { DeploymentConfig } from "../config";

/** The Recorder's own id plus the configured extras (a fork, or a build signed with another key). Never decided by NODE_ENV. */
export function allowedExtensionIds(
  config: Pick<DeploymentConfig, "recorder">,
): string[] {
  return recorderExtensionIds({ extra: config.recorder.extraExtensionIds });
}
