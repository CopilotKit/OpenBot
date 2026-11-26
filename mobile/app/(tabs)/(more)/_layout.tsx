import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/**
 * More's stack: the list. What it opens (Routines, Memory, Skills, Connections, the approval inbox)
 * lives in the app's own stack, so a Bot's page opens the same screens, and nothing stacks.
 */
export default function MoreLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="more" options={tabRoot("More")} />
    </Stack>
  );
}
