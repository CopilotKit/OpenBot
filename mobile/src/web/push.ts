/**
 * This phone, for push notifications, when the app is the web view (./shell.tsx).
 *
 * Asking the person, and getting the push token, are the phone's own and stay native. Telling OpenBot is the
 * page's part, because the page holds the sign-in (./bridge.ts). ../notifications.ts is the same for the app's
 * own screens, where the app holds the sign-in and tells OpenBot itself.
 */
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { Phone } from "./bridge";

/** Where the install keeps the id it made for itself. The same place ../notifications.ts keeps it. */
const DEVICE_ID = "openbot-device-id";

/**
 * This phone as OpenBot registers it, or null when it can't get notifications: a simulator, a build with no
 * Expo project, or a person who said no. Asks the person once, the first time; after a no it never asks again,
 * and they turn notifications on in the phone's settings.
 */
export async function phoneForPush(): Promise<Phone | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (typeof projectId !== "string" || !projectId) return null;
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("openbot", {
      name: "OpenBot",
      importance: Notifications.AndroidImportance.HIGH,
    });
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted" && permission.canAskAgain)
    permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted") return null;
  const { data: token } = await Notifications.getExpoPushTokenAsync({
    projectId,
  });
  let id = await SecureStore.getItemAsync(DEVICE_ID);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID, id);
  }
  return { id, token, projectId, platform: Platform.OS };
}
