import { Link, router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Conversation } from "../src/api";
import { authClient, serverUrl, signIn, signInEnterprise } from "../src/auth";
import { registerPush, unregisterPush } from "../src/notifications";
import { useLoad } from "../src/use-load";
export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushRegistered, setPushRegistered] = useState(false);
  const [older, setOlder] = useState<Conversation[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setPushRegistered(false);
  }, [session?.user.id]);
  const loadOptions = useCallback(
    () =>
      api<{
        authProviders?: ("google" | "microsoft" | "okta")[];
        ssoConfigured?: boolean;
      }>("/api/capabilities"),
    [],
  );
  const options = useLoad(loadOptions, !session);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadConversations = useCallback(
    () =>
      api<{ conversations: Conversation[]; nextCursor: string | null }>(
        "/api/delivery/conversations",
      ),
    [session?.user.id],
  );
  const conversations = useLoad(loadConversations, Boolean(session));
  const nextCursor =
    olderCursor === undefined ? conversations.data?.nextCursor : olderCursor;
  const allConversations = Array.from(
    new Map(
      [...(conversations.data?.conversations ?? []), ...older].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  );
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not complete this action.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      refreshControl={
        <RefreshControl
          refreshing={conversations.pending}
          onRefresh={() => {
            void conversations.refresh();
          }}
        />
      }
    >
      <Text style={{ fontSize: 24, fontWeight: "600" }}>
        {session
          ? `Welcome, ${session.user.name ?? session.user.email}`
          : "Sign in to OpenBot"}
      </Text>
      <Text>{serverUrl}</Text>
      {(error || options.error || conversations.error) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error || options.error || conversations.error}
        </Text>
      )}
      {!session ? (
        <View style={{ gap: 12 }}>
          <Text>
            {isPending
              ? "Checking your session…"
              : "Continue with your organization account."}
          </Text>
          {options.data?.authProviders?.map((provider) => (
            <Button
              key={provider}
              disabled={busy}
              title={`Sign in with ${provider}`}
              onPress={() => {
                void act(async () => {
                  await signIn(provider);
                  router.replace("/");
                });
              }}
            />
          ))}
          {options.data?.ssoConfigured && (
            <>
              <TextInput
                accessibilityLabel="Work email"
                placeholder="Work email"
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
                style={{ borderWidth: 1, padding: 12 }}
              />
              <Button
                disabled={busy || !email}
                title="Continue with organization"
                onPress={() => {
                  void act(() => signInEnterprise(email));
                }}
              />
            </>
          )}
        </View>
      ) : (
        <>
          <Link href="/approvals" style={{ fontSize: 18, color: "#2563eb" }}>
            Questions and approvals
          </Link>
          <Link href="/bots" style={{ fontSize: 18, color: "#2563eb" }}>
            Bots, routines and computers
          </Link>
          <Link href="/memory" style={{ fontSize: 18, color: "#2563eb" }}>
            Memory
          </Link>
          <Button
            disabled={busy}
            title={
              pushRegistered ? "Notifications enabled" : "Enable notifications"
            }
            onPress={() => {
              void act(async () => {
                await registerPush();
                setPushRegistered(true);
              });
            }}
          />
          <Text style={{ fontSize: 20, fontWeight: "600" }}>Conversations</Text>
          {allConversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={{
                pathname: "/conversation",
                params: { channelId: conversation.id },
              }}
              style={{ paddingVertical: 12, color: "#2563eb" }}
            >
              {conversation.name}
              {conversation.active ? "" : " (inactive)"}
            </Link>
          ))}
          {nextCursor && (
            <Button
              title="Older conversations"
              disabled={busy}
              onPress={() => {
                void act(async () => {
                  const page = await api<{
                    conversations: Conversation[];
                    nextCursor: string | null;
                  }>(
                    `/api/delivery/conversations?cursor=${encodeURIComponent(nextCursor)}`,
                  );
                  setOlder((items) => [...items, ...page.conversations]);
                  setOlderCursor(page.nextCursor);
                });
              }}
            />
          )}
          {allConversations.length === 0 && (
            <Text>
              No conversations yet. Create one in OpenBot on your computer.
            </Text>
          )}
          <Button
            disabled={busy}
            title="Sign out"
            onPress={() => {
              void act(async () => {
                await unregisterPush();
                const result = await authClient.signOut();
                if (result.error)
                  throw new Error(
                    result.error.message ?? "Could not sign out.",
                  );
              });
            }}
          />
        </>
      )}
    </ScrollView>
  );
}
