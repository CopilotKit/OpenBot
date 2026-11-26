import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { authClient } from "../src/auth";
import {
  EmptyState,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Text,
} from "../src/components";
import type { AppStanding } from "../src/connect-app";
import { IconPlug } from "../src/icons";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";
import { loadYourConnections } from "../src/your-apps";

/** What each row says about where the app stands. */
const STANDING: Record<AppStanding, string> = {
  connected: "Connected",
  reconnect: "Needs reconnecting",
  not_connected: "Not connected",
  shared: "Your organization's shared account. Bots act as it here.",
  on: "On. It needs no account.",
};

/**
 * Connections: the apps every Bot uses as you, connected or not. Each opens its own screen, where it is connected,
 * reconnected or disconnected. Connecting from the phone is offered only where this OpenBot says it can be
 * (`mobileConnections`); elsewhere the list says to connect on the computer, and an app's screen still shows its
 * accounts and disconnects them.
 */
export default function Connections() {
  const { data: session, isPending } = authClient.useSession();
  const person = session?.user.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for whoever is signed in now
  const load = useCallback(() => loadYourConnections(), [person]);
  const connections = useLoad(load, Boolean(person));
  // Back from an app's screen: the row says what was done there.
  const { refresh } = connections;
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const pull = usePull(refresh);
  if (!session && !isPending) return <Redirect href="/" />;
  const apps = connections.data?.apps;
  const phone = connections.data?.phoneConnects ?? false;
  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Notice message={connections.error} />
      {apps?.length ? (
        <>
          <Text tone="muted" className="px-1 text-sm">
            Connect your accounts so Bots can use apps on your behalf.
          </Text>
          {phone ? null : (
            <Notice
              tone="info"
              message="Connect an app in OpenBot on your computer. It works here once it's connected."
            />
          )}
          <Rows>
            {apps.map((app) => (
              <Row
                key={app.id}
                icon={IconPlug}
                title={app.title}
                description={STANDING[app.standing]}
                // The organization's shared account, and an app with no account, have nothing here to open.
                onPress={
                  app.connect
                    ? () =>
                        router.push({
                          pathname: "/connection",
                          params: {
                            appId: app.id,
                            title: app.title,
                            connect: app.connect ?? "",
                          },
                        })
                    : undefined
                }
              />
            ))}
          </Rows>
        </>
      ) : apps ? (
        <EmptyState
          icon={IconPlug}
          title="No apps yet"
          description="Apps show up here once an admin turns them on."
        />
      ) : null}
    </ScrollScreen>
  );
}
