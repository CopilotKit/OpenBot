import { existsSync, readFileSync } from "node:fs";
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
/**
 * The screen's background, light and dark (src/scheme.ts), and the orb's width on the splash (src/launch-orb.ts).
 * Written out because Expo reads this file without the app's modules; tests/launch-splash.test.ts holds them equal.
 */
export const SPLASH = {
  orbWidth: 112,
  light: "#f8fafb",
  dark: "#0d1319",
} as const;
/**
 * Firebase's settings for the Android app, which Android needs to get a push token. A build on EAS
 * gets the file from the EAS variable GOOGLE_SERVICES_JSON; on your machine it is
 * `google-services.json` next to this file, which git ignores. Without it the app still builds, but
 * an Android phone gets no notifications.
 */
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ??
  (existsSync(join(__dirname, "google-services.json"))
    ? "./google-services.json"
    : undefined);
const config: ExpoConfig = {
  name: "OpenBot",
  slug: "openbot",
  // Named for OpenBot Cloud's project only: another project belongs to whoever builds it.
  ...(ownProjectId ? {} : { owner: "copilotkit" }),
  version: "0.0.1",
  scheme: "openbotmobile",
  // Follow the phone's light or dark setting. Expo's default is light only, which kept the app light
  // under a dark phone even though every color has a dark value.
  userInterfaceStyle: "automatic",
  // OpenBot's orb, the desktop app's icon (desktop/src-tauri/icons/icon.png), on the scheme's background.
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "ai.open.bot.mobile",
    // Built for the iPhone at launch. An iPad still runs it, at the iPhone's size. On, the App Store asks for
    // iPad screenshots and a review on iPad, and a release with it on can never turn it off again.
    supportsTablet: false,
    // The answer to Apple's export question, which every upload asks. The app's only encryption is HTTPS, and it
    // checks signatures (src/security-floor-check.ts). Both are exempt. Change this before the app encrypts anything.
    config: { usesNonExemptEncryption: false },
    icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png" },
  },
  android: {
    package: "ai.open.bot.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: SPLASH.light,
    },
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // The phone's own splash: the same orb, the same size, on the screen's background, light or dark. The app
    // draws it again exactly where the phone left it and carries on from there (src/launch.tsx).
    [
      "expo-splash-screen",
      {
        image: "./assets/orb.png",
        imageWidth: SPLASH.orbWidth,
        resizeMode: "contain",
        backgroundColor: SPLASH.light,
        dark: {
          image: "./assets/orb.png",
          backgroundColor: SPLASH.dark,
        },
      },
    ],
    ["expo-notifications", { defaultChannel: "openbot" }],
    // Back from linking the company account after the process died mid-sign-in: no Custom Tab left below Home.
    "./plugins/linked-cold-start",
  ],
  // Updates without a store release (EAS Update). An installed app takes an update only when its native code is the
  // same as the update's: the runtime version is a fingerprint of the native side (fingerprint.config.js), so nobody
  // has to remember to raise it.
  updates: { url: `https://u.expo.dev/${projectId}` },
  runtimeVersion: { policy: "fingerprint" },
  extra: { openbotRelease, eas: { projectId } },
};
export default config;
