import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { chooseOrganization, organizationChoices } from "../src/api";
import { authClient, serverUrl } from "../src/auth";
import {
  Icon,
  Notice,
  PersonAvatar,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import { IconBell, IconBuilding, IconCheck, IconLogout } from "../src/icons";
import { registerPush, unregisterPush } from "../src/notifications";
import { useLoad } from "../src/use-load";

/**
 * Your account, opened from the menu's footer: who is signed in, the organization they work in
 * (and the others they can switch to), notifications on this phone, and signing out.
 */
export default function Account() {
  const { data: session } = authClient.useSession();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pushRegistered, setPushRegistered] = useState(false);
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
  return (
    <ScrollScreen>
      <View className="flex-row items-center gap-3 px-1">
        <PersonAvatar name={person} size={48} />
        <View className="flex-1">
          <Text variant="heading">{person}</Text>
          {session?.user.name && session.user.email ? (
            <Text tone="muted" className="text-sm">
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
                    current ? <Icon icon={IconCheck} size={18} /> : <View />
                  }
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
                ? "On. Bots can tell you when they need you."
                : "Get told when a Bot needs you."
            }
            trailing={
              pushRegistered ? <Icon icon={IconCheck} size={18} /> : undefined
            }
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
          <Row
            icon={IconLogout}
            title="Sign out"
            tone="danger"
            onPress={
              busy
                ? undefined
                : () =>
                    void act("sign-out", async () => {
                      await unregisterPush();
                      const result = await authClient.signOut();
                      if (result.error)
                        throw new Error(
                          result.error.message ?? "Couldn't sign you out.",
                        );
                    })
            }
          />
        </Rows>
      </Section>
      <Text variant="caption" tone="muted" className="text-center">
        {serverUrl}
      </Text>
    </ScrollScreen>
  );
}
