import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The Routines tab's stack, with the native header. */
export default function RoutinesLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="routines" options={tabRoot("Routines")} />
    </Stack>
  );
}
