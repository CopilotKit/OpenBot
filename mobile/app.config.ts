import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";

/**
 * The Expo project the app's builds belong to. Unset, it is OpenBot Cloud's own: the project `openbot` of the Expo
 * organization `copilotkit`. A company that builds the app for its own OpenBot names its own project here, the same id
 * its server has as EXPO_PROJECT_ID (docs/configuration.md).
 */
const ownProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const projectId = ownProjectId || "a3eaf66f-8f47-4b70-834e-bbcc2b1a8c69";
/** The OpenBot release this app is built from: the repository's own version, which the app names on every request. */
const openbotRelease = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const config: ExpoConfig = {
  name: "OpenBot",
  slug: "openbot",
  // Named for OpenBot Cloud's project only: another project belongs to whoever builds it.
  ...(ownProjectId ? {} : { owner: "copilotkit" }),
  version: "0.0.1",
  scheme: "openbotmobile",
  ios: { bundleIdentifier: "ai.openbot.mobile", supportsTablet: true },
  android: { package: "ai.openbot.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "openbot" }],
    // Back from linking the company account after the process died mid-sign-in: no Custom Tab left below Home.
    "./plugins/linked-cold-start",
  ],
  extra: { openbotRelease, eas: { projectId } },
};
export default config;
