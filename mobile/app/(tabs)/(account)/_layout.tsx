import { Stack } from "expo-router";
import { tabRoot, useHeaderOptions } from "../../../src/header";

/** The Account tab's stack: who is signed in, their organization, this phone, and signing out. */
export default function AccountLayout() {
  return (
    <Stack screenOptions={useHeaderOptions()}>
      <Stack.Screen name="account" options={tabRoot("Account")} />
    </Stack>
  );
}
