import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { api } from "./api";

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
  await api("/api/delivery/devices", {
    method: "POST",
    body: { id, token, projectId, platform: Platform.OS },
  });
  return id;
}
export async function unregisterPush() {
  const id = await SecureStore.getItemAsync(key);
  if (id)
    await api(`/api/delivery/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
}
