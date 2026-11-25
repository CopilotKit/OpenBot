import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { ApiError, ME, ORGANIZATION_ID, organizationsHeld } from "./api";
import { deleteDevice, registerDevice } from "./api/generated/devices/devices";

const key = "openbot-device-id";
export async function registerPush() {
  if (!Device.isDevice)
    throw new Error(
      "Register push notifications on a physical device using a signed development build.",
    );
  if (Platform.OS !== "ios" && Platform.OS !== "android")
    throw new Error("Native push requires iOS or Android.");
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (typeof projectId !== "string" || !projectId)
    throw new Error(
      "Configure the EAS project and APNs/FCM credentials before enabling push.",
    );
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("openbot", {
      name: "OpenBot",
      importance: Notifications.AndroidImportance.HIGH,
    });
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted")
    permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted")
    throw new Error("Notification permission was not granted.");
  const { data: token } = await Notifications.getExpoPushTokenAsync({
    projectId,
  });
  let id = await SecureStore.getItemAsync(key);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(key, id);
  }
  // Registered under the id this install made, every time the app starts: a token Expo has changed
  // replaces the old one rather than adding a second phone.
  await registerDevice(ORGANIZATION_ID, ME, id, {
    token,
    projectId,
    platform: Platform.OS,
  });
  return id;
}
/**
 * Whether this phone gets push notifications: the person allowed them, and the app registered the
 * phone (it keeps the id it registered under until sign-out takes it off).
 */
export async function pushTurnedOn(): Promise<boolean> {
  if (!Device.isDevice) return false;
  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") return false;
  return Boolean(await SecureStore.getItemAsync(key));
}
/**
 * Register again, each time the app starts signed in, on a phone the person already turned
 * notifications on for: a push token Expo changed since replaces the old one, and a phone the server
 * dropped (Expo said it stopped taking them) is registered again. Never asks for permission.
 */
export async function renewPush(): Promise<void> {
  if (await pushTurnedOn()) await registerPush();
}
/**
 * Stop push notifications to this phone, from every organization the person is in: a device is registered in each
 * organization it gets notifications from, so signing out removes it from each.
 */
export async function unregisterPush() {
  const id = await SecureStore.getItemAsync(key);
  if (!id) return;
  // None, for somebody in no organization any more: there is nothing to take the phone off, and they can still sign out.
  for (const organization of await organizationsHeld()) {
    try {
      await deleteDevice(organization.id, ME, id);
    } catch (error) {
      // Removed already, or never registered there: by another sign-out, or by OpenBot once Expo said the phone
      // stopped taking them.
      if (error instanceof ApiError && error.status === 404) continue;
      throw error;
    }
  }
  // Signed out, the phone is nobody's: not registered again at the next start until turned on.
  await SecureStore.deleteItemAsync(key);
}
