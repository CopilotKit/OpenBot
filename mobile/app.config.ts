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
    "./modules/needle/app.plugin.js",
    ["expo-notifications", { defaultChannel: "openbot" }],
    [
      "expo-speech-recognition",
      {
        microphonePermission:
          "OpenBot listens only while you tap the mic, to type what you say.",
        speechRecognitionPermission:
          "OpenBot turns your voice into text on this phone.",
        androidSpeechServicePackages: [
          "com.google.android.as",
          "com.google.android.tts",
          "com.google.android.googlequicksearchbox",
        ],
      },
    ],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
