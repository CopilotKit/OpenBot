import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The Conversations tab's stack, with the native header. */
export default function ConversationsLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="index" options={tabRoot("Chats")} />
    </Stack>
  );
}
