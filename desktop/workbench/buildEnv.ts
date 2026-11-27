import { releaseBuildEnv } from "../scripts/release-build";

/**
 * The VITE_ values the workbench's setup window reads. The workbench shows what a person gets
 * from a release installer, so it starts from the release build's defaults (OpenBot Cloud on).
 * A value in desktop/.env still wins, false included, and Advanced can change it per view.
 */
export function workbenchEnvValues(
  loaded: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...loaded, ...releaseBuildEnv("release", loaded) };
}
