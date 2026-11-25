import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The Bots tab's stack, with the native header. */
export default function BotsLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="bots" options={tabRoot("Bots")} />
    </Stack>
  );
}
