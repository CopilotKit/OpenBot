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
import {
  type ConversationSummary,
  chooseOrganization,
  deploymentOrganization,
  ORGANIZATION_ID,
  organizationChoices,
} from "../src/api";
import { listConversations } from "../src/api/generated/conversations/conversations";
import { getDeployment } from "../src/api/generated/organization-settings/organization-settings";
import { authClient, serverUrl, signIn, signInEnterprise } from "../src/auth";
import { registerPush, unregisterPush } from "../src/notifications";
import { useLoad } from "../src/use-load";
export default function Home() {
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushRegistered, setPushRegistered] = useState(false);
  const [older, setOlder] = useState<ConversationSummary[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setPushRegistered(false);
  }, [session?.user.id]);
  const loadOptions = useCallback(
    // The API's `deployment`, which answers before anybody has signed in: asked of the organization every install has.
    async () => getDeployment(await deploymentOrganization()),
    [],
  );
  const options = useLoad(loadOptions, !session);
  // The person's organizations and the one they work in; picking another reads everything below again.
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  const workingIn = organizations.data?.currentId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, and wherever they work now
  const loadConversations = useCallback(
    () => listConversations(ORGANIZATION_ID, { limit: 100 }),
    [session?.user.id, workingIn],
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
      {session && (organizations.data?.organizations.length ?? 0) > 1 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 20, fontWeight: "600" }}>Organization</Text>
          {organizations.data?.organizations.map((organization) => {
            const current = organization.id === workingIn;
            return (
              <Button
                key={organization.id}
                accessibilityState={{ selected: current }}
                disabled={busy || current}
                title={`${current ? "✓ " : ""}${organization.name ?? organization.id}`}
                onPress={() => {
                  void act(async () => {
                    await chooseOrganization(organization.id);
                    setOlder([]);
                    setOlderCursor(undefined);
                    setPushRegistered(false);
                    await organizations.refresh();
                  });
                }}
              />
            );
          })}
        </View>
      )}
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
          <Link href="/needs-you" style={{ fontSize: 18, color: "#2563eb" }}>
            Needs you
          </Link>
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
                  const page = await listConversations(ORGANIZATION_ID, {
                    limit: 100,
                    cursor: nextCursor,
                  });
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
