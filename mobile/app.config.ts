import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
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
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
