import { readFileSync } from "node:fs";

/**
 * Release and internal installers offer OpenBot Cloud on the first screen. The channel comes
 * from build-version.json, written by desktop-version.ts before Vite builds the window.
 * An explicit VITE_OPENBOT_CLOUD_ENABLED value still wins, including false.
 */
export const RELEASE_BUILD_ENV: Readonly<Record<string, string>> = {
  VITE_OPENBOT_CLOUD_ENABLED: "true",
};

/** Defaults for release and internal installers; unversioned development keeps its own choices. */
export function releaseBuildEnv(
  channel: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (channel !== "release" && channel !== "internal") return {};
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
