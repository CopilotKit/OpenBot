import { router, Stack } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  type ConversationSummary,
  everyBot,
  ORGANIZATION_ID,
  organizationChoices,
} from "../../../src/api";
import { listConversations } from "../../../src/api/generated/conversations/conversations";
import { getCompanySignIn } from "../../../src/api/generated/people/people";
import {
  authClient,
  openInSystemBrowser,
  renewHostedSignIn,
} from "../../../src/auth";
import { HELD_OUT, linkButtons } from "../../../src/company-sign-in";
import { companySignInTicket } from "../../../src/company-sign-in-ticket";
import {
  ConversationRow,
  EmptyState,
  IconButton,
  Notice,
  Refresh,
  Screen,
} from "../../../src/components";
import { plainHeaderRight } from "../../../src/header";
import { homeView } from "../../../src/home-view";
import { IconBuilding, IconMessages, IconPlus } from "../../../src/icons";
import { linkCompanyAccount, onCompanyLinked } from "../../../src/link-company";
import { onOrganizationGone } from "../../../src/organization-gone";
import { onRenewalNeedsClick } from "../../../src/renewal";
import { useLoad } from "../../../src/use-load";
import { usePull } from "../../../src/use-pull";
import { shortWhen } from "../../../src/when";

/**
 * Home: the person's conversations, newest first, each with the Bot it is with. Search sits under
 * the title, as the platform's own lists have it, and a new conversation is the + in the header.
 * Somebody in no organization, or held out of the one they work in, sees only the way forward.
 */
export default function Conversations() {
  const { data: session } = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [foreground, muted] = useCSSVariable([
    "--color-foreground",
    "--color-muted",
  ]) as (string | undefined)[];
  const [older, setOlder] = useState<ConversationSummary[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
  }, [session?.user.id]);
  // The person's organizations and the one they work in; picking another reads everything below again.
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  const workingIn = organizations.data?.currentId;
  const inNone =
    homeView(Boolean(session), organizations.error) === "in-no-organization";
  /*
   * Whether the organization they work in holds them out until they sign in through their company, and the providers
   * that let them. Answered even while it holds them out; read again wherever they work now.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for whoever is signed in now, and wherever they work now
  const loadCompanySignIn = useCallback(
    () => getCompanySignIn(ORGANIZATION_ID, "me"),
    [session?.user.id, workingIn],
  );
  const companySignIn = useLoad(loadCompanySignIn, Boolean(session) && !inNone);
  const view = homeView(
    Boolean(session),
    organizations.error,
    companySignIn.data,
  );
  const working = Boolean(session) && view === "working";
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, and wherever they work now
  const loadConversations = useCallback(
    () => listConversations(ORGANIZATION_ID, { limit: 100 }),
    [session?.user.id, workingIn],
  );
  const conversations = useLoad(loadConversations, working);
  // The Bots, for each conversation's orb and names.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, and wherever they work now
  const loadBots = useCallback(() => everyBot(), [session?.user.id, workingIn]);
  const bots = useLoad(loadBots, working);
  const { refresh: refreshOrganizations } = organizations;
  // A hosted OpenBot's sign-in the phone couldn't renew by itself: "Sign in again" opens it.
  const [renewal, setRenewal] = useState<string | null>(null);
  useEffect(() => onRenewalNeedsClick(setRenewal), []);
  // Back from linking the company account by OpenBot's deep link: the company sign-in is read again.
  const { refresh: refreshCompanySignIn } = companySignIn;
  useEffect(
    () =>
      onCompanyLinked(() => {
        void refreshOrganizations();
        void refreshCompanySignIn();
      }),
    [refreshOrganizations, refreshCompanySignIn],
  );
  // The organization they work in went away while the app was open: everything follows the one they work in now.
  useEffect(
    () =>
      onOrganizationGone(() => {
        setOlder([]);
        setOlderCursor(undefined);
        void refreshOrganizations();
      }),
    [refreshOrganizations],
  );
  const pull = usePull(conversations.refresh, organizations.refresh);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't do that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const nextCursor =
    olderCursor === undefined ? conversations.data?.nextCursor : olderCursor;
  const byId = useMemo(
    () => new Map((bots.data ?? []).map((bot) => [bot.id, bot])),
    [bots.data],
  );
  const listed = useMemo(() => {
    const all = Array.from(
      new Map(
        [...(conversations.data?.conversations ?? []), ...older].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    );
    const words = query.trim().toLowerCase();
    if (!words) return all;
    return all.filter((item) =>
      [item.name, item.lastMessage ?? "", item.summary ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(words),
    );
  }, [conversations.data, older, query]);

  if (view === "held-out" || view === "in-no-organization") {
    return (
      <Screen className="justify-center px-6">
        <EmptyState
          icon={IconBuilding}
          title={
            view === "held-out"
              ? "Sign in through your company"
              : "You aren't in an organization"
          }
          description={
            view === "held-out" ? HELD_OUT : (organizations.error ?? undefined)
          }
          action={
            <View className="w-full gap-2">
              <Notice message={error} />
              {view === "held-out" ? (
                linkButtons(companySignIn.data?.providers ?? []).map((link) => (
                  <Button
                    key={link.providerId}
                    isDisabled={busy}
                    onPress={() => {
                      void act(async () => {
                        /*
                         * A single-use ticket, asked for on this tap and opened at once in the system browser, which
                         * signs in through the company's provider as this person. Back here, the company sign-in is
                         * read again: `met` says whether it took.
                         */
                        await linkCompanyAccount(link.providerId, {
                          ticket: companySignInTicket,
                          open: openInSystemBrowser,
                        });
                        await refreshOrganizations();
                        await companySignIn.refresh();
                      });
                    }}
                  >
                    {link.title}
                  </Button>
                ))
              ) : (
                <Button
                  isDisabled={busy || organizations.pending}
                  onPress={() => void organizations.refresh()}
                >
                  Try again
                </Button>
              )}
              <Button variant="ghost" onPress={() => router.push("/account")}>
                Your account
              </Button>
            </View>
          }
        />
      </Screen>
    );
  }

  const problem =
    error || organizations.error || conversations.error || undefined;
  return (
    <Screen>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: "Search conversations",
            // Under the title: iOS 26 would otherwise float it at the bottom, over the dock.
            placement: "stacked",
            // Android's search field takes no colors from the header's own light or dark.
            textColor: foreground,
            hintTextColor: muted,
            headerIconColor: foreground,
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
          },
          ...plainHeaderRight(() => (
            <IconButton
              icon={IconPlus}
              label="New conversation"
              onPress={() => router.push("/new-conversation")}
            />
          )),
        }}
      />
      <FlatList
        className="flex-1"
        data={listed}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        refreshControl={
          <Refresh refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListHeaderComponent={
          problem || renewal ? (
            <View className="gap-2 px-4 pt-2 pb-2">
              <Notice message={problem} />
              {renewal ? (
                <Notice
                  tone="warning"
                  message="Your sign-in needs renewing before you can do that."
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={busy}
                      className="self-start"
                      onPress={() => {
                        void act(async () => {
                          await renewHostedSignIn(renewal);
                          setRenewal(null);
                          await refreshOrganizations();
                          await conversations.refresh();
                        });
                      }}
                    >
                      Sign in again
                    </Button>
                  }
                />
              ) : null}
            </View>
          ) : undefined
        }
        renderItem={({ item }) => {
          const withBots = item.botIds.map((id) => {
            const bot = byId.get(id);
            return {
              id,
              name: bot?.name ?? "Bot",
              seed: bot?.avatarSeed ?? id,
            };
          });
          const unread =
            Boolean(item.lastMessageAt) &&
            (!item.lastReadAt ||
              (item.lastMessageAt ?? "") > (item.lastReadAt ?? ""));
          return (
            <ConversationRow
              name={item.name}
              bots={withBots}
              lastMessage={item.lastMessage ?? item.summary}
              when={shortWhen(item.lastMessageAt ?? item.createdAt)}
              unread={unread}
              working={Boolean(item.busy) || item.work.length > 0}
              onPress={() =>
                router.push({
                  pathname: "/conversation",
                  params: { channelId: item.id },
                })
              }
            />
          );
        }}
        ListEmptyComponent={
          conversations.data ? (
            <EmptyState
              icon={IconMessages}
              title={query ? "No matches" : "No conversations yet"}
              description={
                query
                  ? "No conversation has those words in it."
                  : "Start one with a Bot with the + button."
              }
            />
          ) : undefined
        }
        ListFooterComponent={
          nextCursor && !query ? (
            <View className="px-4 py-4">
              <Button
                variant="outline"
                isDisabled={busy}
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
              >
                Older conversations
              </Button>
            </View>
          ) : undefined
        }
      />
    </Screen>
  );
}
