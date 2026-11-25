import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { Input } from "heroui-native/input";
import { TextField } from "heroui-native/text-field";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { readDeployment } from "../src/api";
import type { DeploymentAuthProvidersItem } from "../src/api/generated/model";
import { authClient, serverUrl, signIn, signInEnterprise } from "../src/auth";
import { BotOrb, Icon, Notice, Text } from "../src/components";
import {
  IconBrandGoogle,
  IconBrandWindows,
  IconKey,
  IconMail,
  type TablerIcon,
} from "../src/icons";
import { useLoad } from "../src/use-load";

const PROVIDERS: Record<
  DeploymentAuthProvidersItem,
  { name: string; icon: TablerIcon }
> = {
  google: { name: "Google", icon: IconBrandGoogle },
  microsoft: { name: "Microsoft", icon: IconBrandWindows },
  okta: { name: "Okta", icon: IconKey },
};

/**
 * Sign in: OpenBot's orb, a welcome, and each way this OpenBot lets people in. The ways come from
 * the API's `deployment`, which answers before anybody has signed in.
 */
export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [withEmail, setWithEmail] = useState(false);
  // Only once the session has answered, and only for somebody signed out: it is the signed-out screen's.
  const loadOptions = useCallback(() => readDeployment(false), []);
  const options = useLoad(loadOptions, !session && !isPending);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't sign you in. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const providers = (options.data?.authProviders ?? []).filter(
    (provider) => provider in PROVIDERS,
  );
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow justify-center gap-10 px-6"
      contentContainerStyle={{
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="items-center gap-5">
        <BotOrb seed="openbot" name="OpenBot" size={96} />
        <View className="items-center gap-1.5">
          <Text variant="title">Welcome to OpenBot</Text>
          <Text tone="muted">
            {isPending ? "Checking your session…" : "Sign in to get started."}
          </Text>
        </View>
      </View>
      <View className="gap-3">
        <Notice message={error || options.error} />
        {providers.map((provider) => (
          <Button
            key={provider}
            variant="outline"
            isDisabled={busy || isPending}
            onPress={() => {
              void act(async () => {
                await signIn(provider);
                router.replace("/");
              });
            }}
          >
            <Icon icon={PROVIDERS[provider].icon} size={18} />
            <Button.Label>Sign in with {PROVIDERS[provider].name}</Button.Label>
          </Button>
        ))}
        {options.data?.ssoConfigured &&
          (withEmail ? (
            <View className="gap-3">
              <TextField>
                <Input
                  accessibilityLabel="Work email"
                  placeholder="Work email"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChangeText={setEmail}
                />
              </TextField>
              <Button
                isDisabled={busy || !email.trim()}
                onPress={() => {
                  void act(() => signInEnterprise(email.trim()));
                }}
              >
                Continue
              </Button>
            </View>
          ) : (
            <Button
              variant="outline"
              isDisabled={busy || isPending}
              onPress={() => setWithEmail(true)}
            >
              <Icon icon={IconMail} size={18} />
              <Button.Label>Sign in with email</Button.Label>
            </Button>
          ))}
      </View>
      <Text variant="caption" tone="muted" className="text-center">
        {serverUrl}
      </Text>
    </ScrollView>
  );
}
