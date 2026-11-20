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
  readDeployment,
  ORGANIZATION_ID,
  organizationChoices,
} from "../src/api";
import { listConversations } from "../src/api/generated/conversations/conversations";
import {
  authClient,
  renewHostedSignIn,
  serverUrl,
  signIn,
  signInEnterprise,
} from "../src/auth";
import { registerPush, unregisterPush } from "../src/notifications";
import { homeView } from "../src/home-view";
import { onOrganizationGone } from "../src/organization-gone";
import { onRenewalNeedsClick } from "../src/renewal";
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
    () => readDeployment(false),
    [],
  );
  // Only once the session has answered, and only for somebody signed out: it is the signed-out screen's.
  const options = useLoad(loadOptions, !session && !isPending);
  // A failure of that read belongs to the signed-out screen, and is not shown once somebody is signed in.
  const optionsError = session ? undefined : options.error;
  // The person's organizations and the one they work in; picking another reads everything below again.
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  const workingIn = organizations.data?.currentId;
  // In no organization here: nothing that acts on one is offered, and nothing is asked of one.
  const view = homeView(Boolean(session), organizations.error);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, and wherever they work now
  const loadConversations = useCallback(
    () => listConversations(ORGANIZATION_ID, { limit: 100 }),
    [session?.user.id, workingIn],
  );
  const conversations = useLoad(
    loadConversations,
    Boolean(session) && view !== "in-no-organization",
  );
  /*
   * The organization they work in went away while the app was open (they were removed, or it was deleted): their
   * organizations are read again, and everything below follows the one they work in now.
   */
  const { refresh: refreshOrganizations } = organizations;
  /*
   * A hosted OpenBot's sign-in the phone couldn't renew by itself: "Sign in again" opens it, and what is on Home is
   * read again after.
   */
  const [renewal, setRenewal] = useState<string | null>(null);
  useEffect(() => onRenewalNeedsClick(setRenewal), []);
  useEffect(
    () =>
      onOrganizationGone(() => {
        setOlder([]);
        setOlderCursor(undefined);
        void refreshOrganizations();
      }),
    [refreshOrganizations],
  );
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
  const signOutButton = (
    <Button
      disabled={busy}
      title="Sign out"
      onPress={() => {
        void act(async () => {
          await unregisterPush();
          const result = await authClient.signOut();
          if (result.error)
            throw new Error(result.error.message ?? "Could not sign out.");
        });
      }}
    />
  );
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
      {view === "working" &&
        !organizations.error &&
        (organizations.data?.organizations.length ?? 0) > 1 && (
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 20, fontWeight: "600" }}>
              Organization
            </Text>
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
      {(error ||
        optionsError ||
        organizations.error ||
        (view === "working" && conversations.error)) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error ||
            optionsError ||
            organizations.error ||
            (view === "working" ? conversations.error : undefined)}
        </Text>
      )}
      {session && renewal && (
        <View style={{ gap: 8 }}>
          <Text>Your sign-in needs renewing before you can do that.</Text>
          <Button
            disabled={busy}
            title="Sign in again"
            onPress={() => {
              void act(async () => {
                await renewHostedSignIn(renewal);
                setRenewal(null);
                await refreshOrganizations();
                await conversations.refresh();
              });
            }}
          />
        </View>
      )}
      {view === "in-no-organization" ? (
        <>
          <Button
            disabled={busy || organizations.pending}
            title="Try again"
            onPress={() => {
              void organizations.refresh();
            }}
          />
          {signOutButton}
        </>
      ) : !session ? (
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
          {signOutButton}
        </>
      )}
    </ScrollView>
  );
}
