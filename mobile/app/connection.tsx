import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Button } from "heroui-native/button";
import { Description } from "heroui-native/description";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import {
  ApiError,
  everyPage,
  ME,
  ORGANIZATION_ID,
  readDeployment,
} from "../src/api";
import { getApp, getAppSetup } from "../src/api/generated/apps/apps";
import {
  authorizeConnectionAction,
  confirmConnection,
  connectApp,
  disconnectApp,
  disconnectConnectedAccount,
  getConnection,
  getConnectionAuthorizations,
  getConnectionDisconnectPreview,
  listConnectedAccounts,
  makeConnectedAccountDefault,
  recheckConnection,
} from "../src/api/generated/connections/connections";
import type {
  ActionAuthorization,
  ConnectedAccount,
  ConnectionField,
  ConnectionKeyGuide,
} from "../src/api/generated/model";
import { authClient } from "../src/auth";
import {
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import {
  type ConnectOutcome,
  type ConnectSteps,
  confirmOrRead,
  connectAccount,
  disconnectWarning,
  formValues,
  fromParams,
  missingSentence,
  needsReconnecting,
  onConnectionReturned,
  phoneConnects,
  RETURN_ADDRESS,
  returnSentence,
  startingValues,
} from "../src/connect-app";
import { BROWSER_OPTIONS } from "../src/link-company";
import { useAction } from "../src/use-action";
import { webLink } from "../src/web-link";

/**
 * The person's connection to one app, with what hangs off it, or no connection. The app's actions are read only where
 * a connection approves them one at a time (`perAction`, getAppSetup's `authorizesPerAction`), as on the web app:
 * reading them asks the app itself.
 */
/** Whether the person's account is connected, after the app's sign-in: src/connect-app.ts `confirmOrRead`. */
function confirmed(appId: string) {
  return confirmOrRead(appId, {
    confirm: (id) => confirmConnection(ORGANIZATION_ID, ME, id),
    read: async (id) => {
      try {
        await getConnection(ORGANIZATION_ID, ME, id);
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return false;
        throw error;
      }
    },
    // An app whose sign-in OpenBot keeps itself: "That app doesn't connect this way."
    nothingToConfirm: (error) =>
      error instanceof ApiError && error.status === 400,
  });
}

async function readConnection(appId: string, perAction: Promise<boolean>) {
  let connection: Awaited<ReturnType<typeof getConnection>> | null;
  try {
    connection = await getConnection(ORGANIZATION_ID, ME, appId);
  } catch (error) {
    // Not found: not connected (or never was).
    if (error instanceof ApiError && error.status === 404) connection = null;
    else throw error;
  }
  if (!connection)
    return {
      connection,
      accounts: [] as ConnectedAccount[],
      warning: null,
      actions: [] as ActionAuthorization[],
    };
  // Each of these only adds to the page: one that can't be read leaves its part out.
  const [accounts, preview, authorizations] = await Promise.all([
    everyPage(
      (page) => listConnectedAccounts(ORGANIZATION_ID, ME, appId, page),
      (page) => page.accounts,
    ).catch(() => [] as ConnectedAccount[]),
    getConnectionDisconnectPreview(ORGANIZATION_ID, ME, appId).catch(
      () => undefined,
    ),
    perAction.then((listed) =>
      listed
        ? getConnectionAuthorizations(ORGANIZATION_ID, ME, appId).catch(
            () => undefined,
          )
        : undefined,
    ),
  ]);
  return {
    connection,
    accounts,
    warning: disconnectWarning(preview),
    actions:
      authorizations?.readable && Array.isArray(authorizations.actions)
        ? authorizations.actions
        : [],
  };
}
type Read = Awaited<ReturnType<typeof readConnection>>;

/** What an action's row says about it. */
function actionLine(action: ActionAuthorization): string | undefined {
  if (action.state === "authorized") return "Allowed";
  if (action.state === "needs-consent")
    return "Waiting for you to authorize it";
  if (action.state === "needs-admin")
    return action.missing.length
      ? `An admin has to set up ${action.missing.join(", ")} first`
      : "An admin has to set this up first";
  if (action.state === "unknown") return action.reason;
  return undefined;
}

/** A key form in progress: the boxes the app asked for, and whether it adds a second account. */
type KeyForm = {
  fields: ConnectionField[];
  guide: ConnectionKeyGuide | null;
  anotherAccount: boolean;
};

/**
 * One app, and the person's own account at it: whether it is connected, the button that connects, reconnects or
 * connects another account, the accounts when there are several and which one Bots use, the app's actions where they
 * are approved one at a time, and Disconnect, which says first what else it ends.
 *
 * Connecting goes through the system browser's sign-in session, or a key form here (../src/connect-app.ts), and only
 * where this OpenBot lets the phone connect (`mobileConnections`). Elsewhere the screen says to connect on the
 * computer, and the rest still works.
 */
export default function ConnectionScreen() {
  const params = useLocalSearchParams<{
    appId: string;
    title?: string;
    connect?: string;
    returned?: string;
    error?: string;
  }>();
  const appId = params.appId ?? "";
  const { data: session, isPending } = authClient.useSession();
  const person = session?.user.id;
  const action = useAction();
  const [form, setForm] = useState<KeyForm | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const connecting = useRef(false);

  // Read once and when asked, never on a timer: listing the accounts and the actions asks the app itself each time.
  const [read, setRead] = useState<Read>();
  const [readError, setReadError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [about, setAbout] = useState<{
    phone: boolean;
    app?: { title: string; connect: string; ownSignIn: boolean };
  }>();
  const refresh = useCallback(async () => {
    if (!appId || !person) return;
    setPending(true);
    try {
      // What isn't read here leaves its part out: the connection is what the page is.
      const setup = getAppSetup(ORGANIZATION_ID).catch(() => undefined);
      const [connection, deployment, app] = await Promise.all([
        readConnection(
          appId,
          setup.then((each) => each?.authorizesPerAction === true),
        ),
        readDeployment(true).catch(() => undefined),
        // Its title, when opened from the return address with only its id, and how it connects.
        getApp(ORGANIZATION_ID, appId).catch(() => undefined),
      ]);
      setRead(connection);
      setAbout({
        phone: phoneConnects(deployment),
        ...(app
          ? {
              app: {
                title: app.title,
                connect: app.connectsWith === "key" ? "key" : "sign-in",
                // Added by its address and signing each person in itself, as the web app's `user-oauth`: OpenBot
                // keeps the sign-in, so there is no broker to confirm with or disconnect through.
                ownSignIn: app.source !== "directory" && app.signIn === true,
              },
            }
          : {}),
      });
      setReadError(undefined);
    } catch (failure) {
      setReadError(
        failure instanceof Error
          ? failure.message
          : "Couldn't load this connection. Try again in a moment.",
      );
    } finally {
      setPending(false);
    }
  }, [appId, person]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const title = params.title || about?.app?.title || appId;
  const keyApp = (params.connect || about?.app?.connect) === "key";
  const phone = about?.phone ?? false;

  const steps: ConnectSteps = {
    start: (id, body) => connectApp(ORGANIZATION_ID, ME, id, body),
    open: (url, returnTo) =>
      WebBrowser.openAuthSessionAsync(url, returnTo, BROWSER_OPTIONS),
    confirm: confirmed,
  };

  /** What one press came to: a form to fill in, a sentence, or a connection to read again. */
  async function settle(outcome: ConnectOutcome, anotherAccount: boolean) {
    if (outcome.kind === "form") {
      setForm({ fields: outcome.fields, guide: outcome.guide, anotherAccount });
      setTyped(startingValues(outcome.fields));
      return;
    }
    if (outcome.kind === "failed") throw new Error(outcome.message);
    if (outcome.kind === "connected") setForm(null);
    await refresh();
  }

  function connect(anotherAccount = false) {
    void action.run("connect", async () => {
      connecting.current = true;
      try {
        await settle(
          await connectAccount(appId, { anotherAccount }, steps),
          anotherAccount,
        );
      } finally {
        connecting.current = false;
      }
    });
  }

  function sendForm() {
    if (!form) return;
    const filled = formValues(form.fields, typed);
    if ("missing" in filled) {
      action.setError(missingSentence(filled.missing));
      return;
    }
    void action.run("connect", async () =>
      settle(
        await connectAccount(
          appId,
          { anotherAccount: form.anotherAccount, values: filled.values },
          steps,
        ),
        form.anotherAccount,
      ),
    );
  }

  // `action.run` is a new function each render, and the listener below is kept across them.
  const run = useRef(action.run);
  run.current = action.run;
  /** Ask the app again, after the browser came back outside the sign-in session. */
  const confirmReturn = useCallback(
    (error?: string) =>
      run.current("confirm", async () => {
        if (error) throw new Error(returnSentence(error));
        await confirmed(appId);
        await refresh();
      }),
    [appId, refresh],
  );
  // Opened by the return address (app/connections/returned.tsx): the app is asked once.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || !person || !appId) return;
    if (!params.returned && !params.error) return;
    arrived.current = true;
    void confirmReturn(fromParams(params).error);
  }, [person, appId, params, confirmReturn]);
  // The same address while this screen is open.
  useEffect(
    () =>
      onConnectionReturned((returned) => {
        if (returned.appId && returned.appId !== appId) return false;
        // This screen's own press reads the browser's answer itself.
        if (!connecting.current) void confirmReturn(returned.error);
        return true;
      }),
    [appId, confirmReturn],
  );

  if (!session && !isPending) return <Redirect href="/" />;

  const connection = read?.connection;
  const accounts = read?.accounts ?? [];
  const several = accounts.length > 1;
  const reconnect = connection ? needsReconnecting(connection) : false;
  const keyFailed =
    Boolean(connection?.check?.checkedAction) &&
    connection?.check?.verified === false;
  const busy = Boolean(action.busy);

  function sentence(): string {
    if (!connection)
      return `${title} isn't connected. Connect it so Bots can use ${title} as you.`;
    if (several)
      return `You connected ${accounts.length} ${title} accounts. Bots use your default account unless you ask for another.`;
    if (connection.revoked)
      return `${title} no longer accepts this connection. Reconnect it to keep using it.`;
    if (keyFailed)
      return `Your key didn't pass a check with ${title}. Check it again, or reconnect with a new key.`;
    const identity = accounts[0]?.identity;
    if (keyApp) return "Connected with your key.";
    return identity ? `Connected as ${identity}.` : "Connected.";
  }

  function disconnect() {
    Alert.alert(
      `Disconnect ${title}?`,
      [`Your Bots stop using ${title} as you.`, read?.warning]
        .filter(Boolean)
        .join(" "),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void action.run("disconnect", async () => {
              await disconnectApp(ORGANIZATION_ID, ME, appId);
              setForm(null);
              await refresh();
            });
          },
        },
      ],
    );
  }

  function chooseAccount(account: ConnectedAccount) {
    Alert.alert(account.label, undefined, [
      ...(account.isDefault
        ? []
        : [
            {
              text: "Make default",
              onPress: () => {
                void action.run("account", async () => {
                  await makeConnectedAccountDefault(
                    ORGANIZATION_ID,
                    ME,
                    appId,
                    account.id,
                  );
                  await refresh();
                });
              },
            },
          ]),
      {
        text: "Disconnect",
        style: "destructive" as const,
        onPress: () => {
          void action.run("account", async () => {
            await disconnectConnectedAccount(
              ORGANIZATION_ID,
              ME,
              appId,
              account.id,
            );
            await refresh();
          });
        },
      },
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  function recheck() {
    void action.run("recheck", async () => {
      await recheckConnection(ORGANIZATION_ID, ME, appId);
      await refresh();
    });
  }

  function authorize(name: string) {
    void action.run(`authorize:${name}`, async () => {
      const { authorizationUrl } = await authorizeConnectionAction(
        ORGANIZATION_ID,
        ME,
        appId,
        { action: name, returnTo: "mobile" },
      );
      connecting.current = true;
      try {
        await WebBrowser.openAuthSessionAsync(
          authorizationUrl,
          RETURN_ADDRESS,
          BROWSER_OPTIONS,
        );
      } finally {
        connecting.current = false;
      }
      await refresh();
    });
  }

  const guideLink = webLink(form?.guide?.url ?? null);
  const actions = read?.actions ?? [];

  return (
    <ScrollScreen refreshing={pending && Boolean(read)} onRefresh={refresh}>
      <Stack.Screen options={{ title }} />
      <Notice message={action.error || readError} />
      {read ? (
        <>
          <Rows iconless>
            <Row
              title={several ? "Your accounts" : "Your account"}
              description={sentence()}
            />
          </Rows>
          {phone ? (
            <View className="gap-2">
              {!connection || reconnect ? (
                <Button isDisabled={busy} onPress={() => connect()}>
                  {connection ? "Reconnect" : "Connect"}
                </Button>
              ) : null}
              {connection?.check?.checkable && !connection.revoked ? (
                <Button variant="secondary" isDisabled={busy} onPress={recheck}>
                  {action.busy === "recheck" ? "Checking…" : "Check again"}
                </Button>
              ) : null}
              {connection?.canAddAccount && !reconnect ? (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => connect(true)}
                >
                  Connect another account
                </Button>
              ) : null}
            </View>
          ) : !connection || reconnect ? (
            <Notice
              tone="info"
              message={`${connection ? "Reconnect" : "Connect"} ${title} in OpenBot on your computer. It works here once it's connected.`}
            />
          ) : connection.check?.checkable && !connection.revoked ? (
            <Button variant="secondary" isDisabled={busy} onPress={recheck}>
              {action.busy === "recheck" ? "Checking…" : "Check again"}
            </Button>
          ) : null}
          {form ? (
            <Section title="Connect your account">
              <View className="gap-4">
                {form.guide?.steps ? (
                  <Text tone="muted" className="px-1 text-sm">
                    {form.guide.steps}
                  </Text>
                ) : null}
                {guideLink ? (
                  <Button
                    variant="ghost"
                    onPress={() =>
                      void WebBrowser.openBrowserAsync(guideLink.href)
                    }
                  >
                    {`Get a key from ${title}`}
                  </Button>
                ) : null}
                {form.fields.map((field) => (
                  <TextField key={field.name} isRequired={field.required}>
                    <Label>{field.label}</Label>
                    <Input
                      value={typed[field.name] ?? ""}
                      onChangeText={(value) =>
                        setTyped((now) => ({ ...now, [field.name]: value }))
                      }
                      secureTextEntry={field.secret}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    {field.help ? (
                      <Description>{field.help}</Description>
                    ) : null}
                  </TextField>
                ))}
                <Button isDisabled={busy} onPress={sendForm}>
                  {action.busy === "connect" ? "Connecting…" : "Connect"}
                </Button>
              </View>
            </Section>
          ) : null}
          {several ? (
            <Section title="Your accounts">
              <Rows iconless>
                {accounts.map((account) => (
                  <Row
                    key={account.id}
                    title={account.label}
                    description={
                      account.isDefault
                        ? "Default. Bots use this account unless you ask for another."
                        : "Bots use it when you ask for it."
                    }
                    chevron={false}
                    onPress={busy ? undefined : () => chooseAccount(account)}
                  />
                ))}
              </Rows>
            </Section>
          ) : null}
          {connection && actions.length ? (
            <Section title="Actions">
              <Rows iconless>
                {actions.map((each) => (
                  <Row
                    key={each.action}
                    title={each.action}
                    description={actionLine(each)}
                    trailing={
                      each.state === "needs-consent" && phone ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={busy}
                          onPress={() => authorize(each.action)}
                        >
                          Authorize
                        </Button>
                      ) : undefined
                    }
                  />
                ))}
              </Rows>
            </Section>
          ) : null}
          {connection && !several && !about?.app?.ownSignIn ? (
            <Rows iconless>
              <Row
                title="Disconnect"
                tone="danger"
                chevron={false}
                onPress={busy ? undefined : disconnect}
              />
            </Rows>
          ) : null}
        </>
      ) : null}
    </ScrollScreen>
  );
}
