import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * EXPO_PUBLIC_OPENBOT_TEST_BUILD=1 at `expo prebuild` and at bundling makes a TEST build: the test
 * hooks in the JavaScript (src/testHooks.ts), http to localhost (App Transport Security's local
 * networking on iOS, a cleartext exception for localhost on Android) and web view debugging. Without
 * it the build is the store build: https only, no hooks. CI builds both and checks the store one.
 */
const TEST_BUILD = process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD === "1";
const LIGHT_BACKGROUND = "#f8fafb";
const DARK_BACKGROUND = "#0d1319";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "OpenBot",
  slug: "openbot-rn-shell",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/openbot-mark.png",
  userInterfaceStyle: "automatic",
  backgroundColor: LIGHT_BACKGROUND,
  ios: {
    bundleIdentifier: "ai.openbot.rnshell",
    buildNumber: "1",
    supportsTablet: false,
    // The hand-off's https callback (iOS 17.4+). Takes effect only in a build signed with the team's
    // profile and with the association file on the domain naming the Team ID (a release task).
    associatedDomains: ["applinks:my.open.bot", "webcredentials:my.open.bot"],
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIRequiresFullScreen: true,
    },
  },
  android: {
    package: "ai.openbot.rnshell",
    versionCode: 1,
    allowBackup: false,
    blockedPermissions: [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.RECORD_AUDIO",
    ],
    // The sign-in callbacks (openbotshell://signed-in and the https App Link) are declared on a
    // translucent trampoline in modules/shell-native (its AndroidManifest.xml), not on MainActivity.
  },
  plugins: [
    [
      "expo-splash-screen",
      {
        image: "./assets/openbot-mark.png",
        imageWidth: 72,
        resizeMode: "contain",
        backgroundColor: LIGHT_BACKGROUND,
        dark: {
          image: "./assets/openbot-mark.png",
          backgroundColor: DARK_BACKGROUND,
        },
      },
    ],
    [
      "expo-build-properties",
      { ios: { deploymentTarget: "17.0" }, android: { minSdkVersion: 26 } },
    ],
    ["./plugins/withOpenBotShell", { testBuild: TEST_BUILD }],
  ],
  extra: { testBuild: TEST_BUILD },
});
