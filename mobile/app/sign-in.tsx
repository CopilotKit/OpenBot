import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { authClient, serverUrl, signIn } from "../src/auth";
import { Notice, Text } from "../src/components";
import { LaunchOrb, LaunchReveal } from "../src/launch";

/**
 * Sign in: OpenBot's orb, a welcome, and one Sign in button. Opening the app signed out, the launch splash's orb
 * glides into this one and the rest rises in after it (../src/launch.tsx). It opens this OpenBot's own sign-in
 * page in the system browser (../src/oauth.ts), which offers every way in it has, OpenBot Cloud's
 * included.
 */
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    setError("");
    try {
      // False when the person closed the browser: nothing to say, they can try again.
      if (await signIn()) router.replace("/");
    } catch (failure) {
      // A SignInError's message is written for the person.
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't sign you in. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow justify-center gap-10 px-6"
      contentContainerStyle={{
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
      }}
    >
      <View className="items-center gap-5">
        <LaunchOrb size={96} />
        <View className="items-center gap-1.5">
          <LaunchReveal order={0}>
            <Text variant="title">Welcome to OpenBot</Text>
          </LaunchReveal>
          <LaunchReveal order={1}>
            <Text tone="muted" className="text-center">
              {isPending
                ? "Checking your session…"
                : "Sign in with your OpenBot account to pick up where you left off."}
            </Text>
          </LaunchReveal>
        </View>
      </View>
      <LaunchReveal order={2} className="gap-3">
        <Notice message={error} />
        <Button isDisabled={busy || isPending} onPress={() => void start()}>
          Sign in
        </Button>
      </LaunchReveal>
      <LaunchReveal order={3}>
        <Text variant="caption" tone="muted" className="text-center">
          {serverUrl}
        </Text>
      </LaunchReveal>
    </ScrollView>
  );
}
