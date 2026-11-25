import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The Needs you tab's stack, with the native header. */
export default function NeedsYouLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="needs-you" options={tabRoot("Needs you")} />
    </Stack>
  );
}
