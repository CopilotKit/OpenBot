import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The app's way back to More, when one of its screens was opened by itself from a link. */
export const unstable_settings = { initialRouteName: "more" };

/** More's stack: the list, and Memory, Skills and Connections opened from it. */
export default function MoreLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="more" options={tabRoot("More")} />
      <Stack.Screen name="memory" options={{ title: "Memory" }} />
      <Stack.Screen name="skills" options={{ title: "Skills" }} />
      <Stack.Screen name="connections" options={{ title: "Connections" }} />
    </Stack>
  );
}
