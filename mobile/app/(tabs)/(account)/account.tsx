import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { chooseOrganization, organizationChoices } from "../../../src/api";
import { authClient, serverUrl } from "../../../src/auth";
import {
  Icon,
  Notice,
  PersonAvatar,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../../../src/components";
import {
  IconBell,
  IconBuilding,
  IconCheck,
  IconLogout,
} from "../../../src/icons";
import {
  pushTurnedOn,
  registerPush,
  unregisterPush,
} from "../../../src/notifications";
import { useLoad } from "../../../src/use-load";

/**
 * Your account, a tab of its own: who is signed in, the organization they work in
 * (and the others they can switch to), notifications on this phone, and signing out. It opens as a
 * Bot's page does: the person, centered, then a card of rows for each part.
 */
export default function Account() {
  const { data: session } = authClient.useSession();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pushRegistered, setPushRegistered] = useState(false);
  // Said as it is on this phone, not as it was before the app last started.
  useEffect(() => {
    void pushTurnedOn()
      .then(setPushRegistered)
      .catch(() => {});
  }, []);
  const loadOrganizations = useCallback(() => organizationChoices(), []);
  const organizations = useLoad(loadOrganizations, Boolean(session));
  async function act(name: string, work: () => Promise<unknown>) {
    setBusy(name);
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
      setBusy("");
    }
  }
  const person = session?.user.name || session?.user.email || "";
  const listed = organizations.data?.organizations ?? [];
  // The OpenBot this phone is signed in to, as its address reads without the scheme.
  const server = serverUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <ScrollScreen>
      <View className="items-center gap-3">
        <PersonAvatar name={person} size={64} />
        <View className="items-center gap-1">
          <Text variant="heading" className="text-center">
            {person}
          </Text>
          {session?.user.name && session.user.email ? (
            <Text tone="muted" className="text-center text-sm">
              {session.user.email}
            </Text>
          ) : null}
        </View>
      </View>
      <Notice message={error || organizations.error} />
      {listed.length > 0 ? (
        <Section title={listed.length > 1 ? "Organizations" : "Organization"}>
          <Rows>
            {listed.map((organization) => {
              const current = organization.id === organizations.data?.currentId;
              return (
                <Row
                  key={organization.id}
                  icon={IconBuilding}
                  title={organization.name ?? organization.id}
                  description={current ? "You're working here" : undefined}
                  trailing={
                    current ? <Icon icon={IconCheck} size={18} /> : undefined
                  }
                  chevron={false}
                  onPress={
                    current || busy
                      ? undefined
                      : () =>
                          void act(organization.id, async () => {
                            await chooseOrganization(organization.id);
                            await organizations.refresh();
                            router.dismissAll();
                            router.replace("/");
                          })
                  }
                />
              );
            })}
          </Rows>
        </Section>
      ) : null}
      <Section title="This phone">
        <Rows>
          <Row
            icon={IconBell}
            title="Notifications"
            description={
              pushRegistered
                ? "On. Bots can tell you when they finish or need you."
                : "Get told when a Bot finishes or needs you."
            }
            trailing={
              pushRegistered ? (
                <Icon icon={IconCheck} size={18} />
              ) : (
                <Text variant="caption" className="font-medium">
                  Turn on
                </Text>
              )
            }
            chevron={false}
            onPress={
              pushRegistered || busy
                ? undefined
                : () =>
                    void act("push", async () => {
                      await registerPush();
                      setPushRegistered(true);
                    })
            }
          />
        </Rows>
      </Section>
      <Rows>
        <Row
          icon={IconLogout}
          title="Sign out"
          description={`Signed in to ${server}`}
          tone="danger"
          chevron={false}
          onPress={
            busy
              ? undefined
              : () =>
                  void act("sign-out", async () => {
                    await unregisterPush();
                    await authClient.signOut();
                  })
          }
        />
      </Rows>
    </ScrollScreen>
  );
}
