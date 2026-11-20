import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
/** The OpenBot release this app is built from: the repository's own version, which the app names on every request. */
const openbotRelease = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;
const config: ExpoConfig = {
  name: "OpenBot",
  slug: "openbot",
  version: "0.0.1",
  scheme: "openbotmobile",
  ios: { bundleIdentifier: "ai.openbot.mobile", supportsTablet: true },
  android: { package: "ai.openbot.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "openbot" }],
  ],
  extra: { openbotRelease, ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
