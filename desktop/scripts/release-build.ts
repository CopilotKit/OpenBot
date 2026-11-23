import { readFileSync } from "node:fs";

/**
 * The release build config: the window's build-time values a release or a candidate installer is
 * built with, which an internal or a pull request build is not. Every release installer, unsigned
 * (`desktop-build.yml` with the `release` channel) or signed (the signing workflows on a tag), runs
 * `desktop-version.ts release` before `tauri build`, so `build-version.json` names its channel when
 * Vite builds the window (`vite.config.ts`).
 *
 * `VITE_OPENBOT_CLOUD_ENABLED`: OpenBot Cloud on the first screen, first and picked
 * (`CloudSignIn.tsx`, `Welcome.tsx`).
 *
 * A value already in the build's environment wins, so a release build can still turn a switch off:
 * `VITE_OPENBOT_CLOUD_ENABLED=false`.
 */
export const RELEASE_BUILD_ENV: Readonly<Record<string, string>> = {
  VITE_OPENBOT_CLOUD_ENABLED: "true",
};

/** What to add to a build's environment: the release build config for a release, and nothing else. */
export function releaseBuildEnv(
  channel: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (channel !== "release") return {};
  return Object.fromEntries(
    Object.entries(RELEASE_BUILD_ENV).filter(
      ([name]) => environment[name] === undefined,
    ),
  );
}

/** The channel `desktop-version.ts` wrote for this build, or none before it has run. */
export function buildChannel(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // No build-version.json: a development build, or a build that never ran desktop-version.ts.
    return undefined;
  }
  const channel = (JSON.parse(text) as { channel?: unknown }).channel;
  return typeof channel === "string" ? channel : undefined;
}
