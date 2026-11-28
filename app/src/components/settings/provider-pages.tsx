import {
  IconAlertTriangle,
  IconChevronRight,
  IconPlugConnectedX,
  IconSparkles,
  IconStar,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, Fragment, useState } from "react";
import { CONNECT_YOUR_AI_PATH } from "@/components/channels/add-model-key-link";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type AiConnectionOwner,
  connectionName,
  describeConnection,
} from "@/lib/ai-connection/describe";
import {
  type Connected,
  makeDefaultAiConnectionMutationOptions,
  removeAiConnectionMutationOptions,
} from "@/lib/ai-connection/mutations";
import {
  AI_PROVIDERS_TITLE,
  type JustConnected,
  useProviderPaths,
} from "@/lib/ai-connection/paths";
import {
  AI_PROVIDERS,
  GOOGLE_SIGN_IN_ENDED,
  isSignIn,
  providerById,
  signInRetired,
} from "@/lib/ai-connection/providers";
import {
  type AiConnectionEntry,
  type AiConnections,
  aiConnectionQueryOptions,
  aiConnectionsQueryOptions,
  type ConnectionScope,
  desktopAiSupportQueryOptions,
  needsAiConnection,
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connection/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { failureSaid } from "@/lib/load-failure";
import { queryClient } from "@/query-client";
import { AiModelSection } from "./ai-connection";
import {
  ChooseConnection,
  ChooserCard,
  ConnectedRow,
} from "./ai-connection-chooser";
import { lastGoes } from "./ai-connection-list";
import { YourAiSection } from "./your-ai";

/**
 * Settings → AI providers and Admin → AI providers, as screens rather than dialogs
 * (`.claude/skills/openbot-screen-layout`, Screens, Not Dialogs):
 *
 * - The list: one row per connected provider, each a link to its page, and a row that connects
 *   another (ai-connection-list.tsx).
 * - A provider's page: how OpenBot signs in to it, Change (or Sign in again, Replace key), Make
 *   default, and Disconnect, which says beside its button what happens and, for the default with
 *   several left, asks which takes over.
 * - Connect another AI, and Change: the chooser Settings and onboarding share, on a card.
 *
 * Both places draw these same components; the links between them come from `useProviderPaths`.
 */

/** What every provider page reads: whose list, the list, and where it runs. */
function useProviders(scope: ConnectionScope) {
  const list = useQuery(aiConnectionsQueryOptions(scope));
  const support = useQuery(desktopAiSupportQueryOptions());
  const personal = useQuery(personalAiConnectionQueryOptions());
  // Each person brings their own AI here (OpenBot Cloud): the organization's is for everyone else.
  const organizationWide = personal.data?.available === true;
  const owner: AiConnectionOwner =
    scope === "organization" && organizationWide ? "organization" : "you";
  return {
    list,
    personal: personal.data,
    organizationWide,
    owner,
    // Inside an OpenBot Desktop that changes the organization's AI in place.
    inDesktop: support.data === "in-place",
    pending: list.isPending || support.isPending || personal.isPending,
  };
}

/** A provider's name before its connection is read, from the address. */
function nameFromAddress(id: string): string {
  return AI_PROVIDERS.find((provider) => provider.id === id)?.name ?? "AI";
}

const LIST_FAILED = "Couldn't load your AI connections. Try again in a moment.";

/**
 * Settings → AI providers: the person's own AI on OpenBot Cloud, and the organization's for whoever
 * may change it. The organization's alone everywhere else, where it is what every Bot runs on.
 */
export function ProvidersSettingsPage() {
  const connection = useQuery(aiConnectionQueryOptions());
  const personal = useQuery(personalAiConnectionQueryOptions());
  const cloud = personal.data?.available === true;
  const settled = !connection.isPending && !personal.isPending;
  /*
   * Nothing to set here: a member of a team OpenBot, whose admin sets the AI, in a plain browser.
   * Inside OpenBot Desktop the section draws the row from before on its own.
   */
  const nothingHere =
    settled &&
    !cloud &&
    connection.data?.editable !== true &&
    desktopShell() === null;
  return (
    <PageShell
      description={
        cloud
          ? "Bots use your own AI when they work for you. Anyone who hasn't connected one uses your organization's."
          : "Connect the AI providers your Bots run on. Bots use the default unless someone picks a model from another provider in a conversation."
      }
      title={AI_PROVIDERS_TITLE}
    >
      {cloud ? <YourAiSection /> : null}
      {nothingHere ? (
        <PageEmpty icon={IconSparkles} title="Set by your organization">
          Your Bots run on the AI your organization's admin set up.
        </PageEmpty>
      ) : (
        <AiModelSection alone={!cloud} organizationWide={cloud} />
      )}
    </PageShell>
  );
}

/** One provider's page: what it is, and the ways to change, promote and disconnect it. */
export function ProviderPage({
  id,
  scope,
  connected,
}: {
  id: string;
  scope: ConnectionScope;
  connected?: JustConnected;
}) {
  const paths = useProviderPaths();
  const providers = useProviders(scope);
  const back = { label: AI_PROVIDERS_TITLE, linkProps: paths.list() };
  const entry = providers.list.data?.connections.find(
    (connection) => connection.id === id,
  );
  // Just connected, the list may still be the one read before it: wait for it to be read again.
  if (providers.pending || (!entry && providers.list.isFetching))
    return (
      <PageShell backButton={back} title={nameFromAddress(id)}>
        {null}
      </PageShell>
    );
  if (!providers.list.data)
    return (
      <PageShell backButton={back} title={nameFromAddress(id)}>
        <p className="text-destructive text-sm" role="alert">
          {LIST_FAILED}
        </p>
      </PageShell>
    );
  if (!entry)
    return (
      <PageShell backButton={back} title={nameFromAddress(id)}>
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...paths.connect(scope)} {...props} />}
              size="sm"
            >
              Connect an AI
            </Button>
          }
          icon={IconSparkles}
          title="Not connected"
        >
          {nameFromAddress(id)} isn't connected.
        </PageEmpty>
      </PageShell>
    );
  return (
    <ProviderDetails
      back={back}
      connected={connected}
      entry={entry}
      inDesktop={providers.inDesktop}
      list={providers.list.data}
      organizationWide={providers.organizationWide}
      owner={providers.owner}
      personal={providers.personal}
      scope={scope}
    />
  );
}

function ProviderDetails({
  back,
  connected,
  entry,
  inDesktop,
  list,
  organizationWide,
  owner,
  personal,
  scope,
}: {
  back: ComponentProps<typeof PageShell>["backButton"];
  connected?: JustConnected;
  entry: AiConnectionEntry;
  inDesktop: boolean;
  list: AiConnections;
  organizationWide: boolean;
  owner: AiConnectionOwner;
  personal: PersonalAiConnection | null | undefined;
  scope: ConnectionScope;
}) {
  const paths = useProviderPaths();
  const navigate = useNavigate();
  const desktop = inDesktop && scope === "organization";
  const makeDefault = useMutation(
    makeDefaultAiConnectionMutationOptions(queryClient, scope),
  );
  const remove = useMutation(
    removeAiConnectionMutationOptions(queryClient, scope),
  );
  const others = list.connections.filter(
    (other) => other.id !== entry.id && other.ready,
  );
  /*
   * The one connection a removal would leave, which the server then makes the default itself. With
   * more left, the person chooses which takes over, from those that can run.
   */
  const left = list.connections.filter((other) => other.id !== entry.id);
  const onlyOne = left.length === 1 ? left[0] : undefined;
  const choosing = entry.isDefault && !onlyOne && others.length > 0;
  // The default goes with others left, none of which can run: they stay, and none is the default.
  const noneCanTakeOver = entry.isDefault && left.length > 1 && !choosing;
  const [nextDefault, setNextDefault] = useState<string | null>(
    others[0]?.id ?? null,
  );
  // Inside OpenBot Desktop the default's plan engine runs beside it; the way off it is Change.
  const canDisconnect = !(desktop && entry.isDefault);
  // The organization's default changes in place (replaceAiConnection); any other connects again.
  const changesInPlace = scope === "organization" && entry.isDefault;
  const busy = makeDefault.isPending || remove.isPending;
  const name = connectionName(entry);
  const described = describeConnection(entry, owner);
  const retired = signInRetired(entry);

  /**
   * After a removal, back to the list. A person whose runs now have no AI, where one is required, is
   * sent to connect one, as removing their own AI always did (the server's verdict, read again).
   */
  const afterRemoving = () => {
    void navigate(paths.list());
    if (scope !== "personal") return;
    void queryClient
      .fetchQuery({ ...personalAiConnectionQueryOptions(), staleTime: 0 })
      .then((after) => {
        if (needsAiConnection(after))
          window.location.assign(CONNECT_YOUR_AI_PATH);
      })
      .catch(() => {});
  };

  return (
    <PageShell
      backButton={back}
      description={
        entry.isDefault
          ? "Bots use it when nobody picked a model. OpenBot keeps the key or sign-in and never shows it."
          : "Bots use it when someone picks one of its models. OpenBot keeps the key or sign-in and never shows it."
      }
      title={name}
    >
      {connected ? (
        <p className="text-muted-foreground text-sm" role="status">
          {connected === "added"
            ? "Connected. Pick one of its models in a conversation to use it. The default stays as it was."
            : owner === "organization"
              ? "Connected. Bots use it for anyone in your organization who hasn't connected their own AI."
              : "Connected. Your next message runs on it. Anything already running finishes on the connection it started with."}
        </p>
      ) : null}
      {retired ? (
        /*
         * A Google sign-in OpenBot no longer offers: what happened, and the one way on, which opens
         * Google Gemini's API key on this same connection.
         */
        <PageRows>
          <Item role="alert" size="sm">
            <ItemMedia variant="icon">
              <IconAlertTriangle className="text-destructive" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{GOOGLE_SIGN_IN_ENDED.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {GOOGLE_SIGN_IN_ENDED.body}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                render={(props) => (
                  <Link {...paths.change(entry.id, scope)} {...props} />
                )}
                size="sm"
              >
                {GOOGLE_SIGN_IN_ENDED.action}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      ) : entry.ready ? null : (
        <p className="text-destructive text-sm" role="alert">
          {entry.problem?.detail}
        </p>
      )}
      <PageSection title="Connection">
        <PageRows>
          {(described?.details ?? []).map((detail, index) => (
            <Fragment key={detail.label}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{detail.label}</ItemTitle>
                </ItemContent>
                <ItemActions className="min-w-0">
                  <span className="truncate text-muted-foreground text-sm">
                    {detail.value}
                  </span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {/* A retired sign-in's way on is the notice's button above: it is the change. */}
          {retired ? null : (
            <>
              {described?.details.length ? <Separator /> : null}
              <Item
                render={<Link {...paths.change(entry.id, scope)} />}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>
                    {entry.ready
                      ? "Change"
                      : isSignIn(entry.login)
                        ? "Sign in again"
                        : "Replace key"}
                  </ItemTitle>
                  <ItemDescription>
                    {changesInPlace
                      ? "Switch to another provider, plan or key. Runs that start after that use it."
                      : "Sign in again, or use another key."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          )}
        </PageRows>
      </PageSection>
      {entry.isDefault ? null : (
        <PageSection title="Default">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconStar />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Make it the default</ItemTitle>
                <ItemDescription>
                  {entry.ready
                    ? "Bots use the default when nobody picked a model."
                    : "Fix it before you make it the default."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={busy || !entry.ready}
                  onClick={() => makeDefault.mutate({ entry, desktop })}
                  size="sm"
                  variant="outline"
                >
                  {makeDefault.isPending
                    ? "Making it the default…"
                    : "Make default"}
                </Button>
              </ItemActions>
            </Item>
          </PageRows>
          {makeDefault.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {failureSaid(makeDefault.error)}
            </p>
          ) : null}
        </PageSection>
      )}
      {canDisconnect ? (
        <PageSection title="Disconnect">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlugConnectedX />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Disconnect {name}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {!entry.isDefault
                    ? "Its models are no longer offered in conversations. The default stays as it is."
                    : onlyOne
                      ? `Bots will use ${connectionName(onlyOne)} when nobody picked a model.`
                      : choosing
                        ? "It's the default AI. Choose which one Bots use when nobody picked a model."
                        : noneCanTakeOver
                          ? "It's the default AI, and none of the others can run now. Disconnect it and there's no default until you fix one and make it the default."
                          : lastGoes(scope, organizationWide, personal)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={busy}
                  onClick={() =>
                    /*
                     * Awaited rather than mutate's own onSuccess: the list read again after the
                     * removal no longer has this connection, so this page goes before the removal
                     * settles, and a callback passed to mutate never runs once it has.
                     */
                    remove
                      .mutateAsync({
                        id: entry.id,
                        nextDefault: choosing
                          ? others.find((other) => other.id === nextDefault)
                          : undefined,
                        desktop,
                      })
                      .then(afterRemoving)
                      // Said under the button from remove.error.
                      .catch(() => {})
                  }
                  size="sm"
                  variant="destructive"
                >
                  {remove.isPending ? "Disconnecting…" : "Disconnect"}
                </Button>
              </ItemActions>
              {choosing ? (
                <ItemFooter>
                  <fieldset className="m-0 flex w-full flex-col gap-2 border-0 p-0">
                    <legend className="mb-2 text-muted-foreground text-sm">
                      Bots will use
                    </legend>
                    {others.map((other) => (
                      <label
                        className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5 text-sm"
                        key={other.id}
                      >
                        <input
                          checked={nextDefault === other.id}
                          className="size-4 shrink-0 accent-foreground"
                          name="next-default"
                          onChange={() => setNextDefault(other.id)}
                          type="radio"
                        />
                        {connectionName(other)}
                      </label>
                    ))}
                  </fieldset>
                </ItemFooter>
              ) : null}
            </Item>
          </PageRows>
          {remove.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {failureSaid(remove.error)}
            </p>
          ) : null}
        </PageSection>
      ) : null}
    </PageShell>
  );
}

/**
 * Connect one more AI beside the others: the shared chooser, on its own page.
 *
 * Each connection goes back to the list, where what was connected has a check, as onboarding's
 * Connect your AI does: the person may connect another, or leave with Done. A provider's own page
 * is where a connection is changed, made the default or disconnected, not where adding one ends.
 * The chooser is drawn again from the list the connection refreshed (its mutation waits for that),
 * and a line only a screen reader hears says what was connected, since the form it was in is gone.
 */
export function ConnectProviderPage({ scope }: { scope: ConnectionScope }) {
  const paths = useProviderPaths();
  const navigate = useNavigate();
  const providers = useProviders(scope);
  const [lastConnected, setLastConnected] = useState<{
    provider: Connected["connection"]["provider"];
    round: number;
  }>();
  const connectedName = lastConnected
    ? (providerById(lastConnected.provider)?.name ?? "Your AI")
    : null;
  const back = { label: AI_PROVIDERS_TITLE, linkProps: paths.list() };
  const list = providers.list.data;
  const first = list?.connections.length === 0;
  const title = first
    ? scope === "personal"
      ? "Connect your AI"
      : "Connect an AI"
    : "Connect another AI";
  if (providers.pending)
    return (
      <PageShell backButton={back} title={title}>
        {null}
      </PageShell>
    );
  if (!list)
    return (
      <PageShell backButton={back} title={title}>
        <p className="text-destructive text-sm" role="alert">
          {LIST_FAILED}
        </p>
      </PageShell>
    );
  return (
    <PageShell
      backButton={back}
      description={
        first
          ? scope === "personal"
            ? "Choose the AI your Bots use when they work for you. It's yours alone."
            : "Choose the AI your Bots use. OpenBot checks the connection before it saves it."
          : "Choose another AI your Bots can use. The ones already connected keep working."
      }
      title={title}
    >
      <ChooserCard>
        <ChooseConnection
          connectedHere={lastConnected !== undefined}
          initialFocusProvider={lastConnected?.provider ?? undefined}
          key={lastConnected?.round ?? 0}
          mode={{
            kind: "adding",
            scope,
            signIns: list.signIns,
            connected: list.connections,
            owner: providers.owner,
          }}
          onBack={() => void navigate(paths.list())}
          onConnected={({ connection }) =>
            setLastConnected((previous) => ({
              provider: connection.provider,
              round: (previous?.round ?? 0) + 1,
            }))
          }
        />
      </ChooserCard>
      <p aria-live="polite" className="sr-only" role="status">
        {connectedName ? `${connectedName} is connected.` : ""}
      </p>
    </PageShell>
  );
}

/**
 * Change one connection. The organization's default changes in place, as it always did
 * (replaceAiConnection), which inside OpenBot Desktop is the one way to a plan Desktop holds. Any
 * other connects its own provider again, which replaces it: a stopped one is fixed this way.
 */
export function ChangeProviderPage({
  id,
  scope,
}: {
  id: string;
  scope: ConnectionScope;
}) {
  const paths = useProviderPaths();
  const navigate = useNavigate();
  const providers = useProviders(scope);
  const entry = providers.list.data?.connections.find(
    (connection) => connection.id === id,
  );
  const changesInPlace = scope === "organization" && entry?.isDefault === true;
  const current = useQuery({
    ...aiConnectionQueryOptions(),
    enabled: changesInPlace,
  });
  // Desktop's sentence when it couldn't finish after the switch: shown here, not lost on the way.
  const [done, setDone] = useState<Connected | null>(null);
  const back = {
    label: nameFromAddress(id),
    linkProps: paths.provider(id, scope),
  };
  const name = entry ? connectionName(entry) : nameFromAddress(id);
  // A Google sign-in OpenBot no longer offers: this page takes its Gemini API key.
  const retired = signInRetired(entry);
  const title = !entry
    ? `Change ${name}`
    : retired
      ? GOOGLE_SIGN_IN_ENDED.action
      : changesInPlace
        ? providers.organizationWide
          ? "Change your organization's AI"
          : "Change AI connection"
        : entry.ready
          ? `Change ${name}`
          : `Reconnect ${name}`;
  if (done)
    return (
      <PageShell
        backButton={{ label: AI_PROVIDERS_TITLE, linkProps: paths.list() }}
        title={`Connected to ${describeConnection(done.connection)?.provider ?? "your AI"}`}
      >
        <ConnectedRow connection={done.connection} owner={providers.owner} />
        <p className="mt-3 text-destructive text-sm" role="alert">
          {done.desktopProblem}
        </p>
      </PageShell>
    );
  if (providers.pending || (changesInPlace && current.isPending))
    return (
      <PageShell backButton={back} title={title}>
        {null}
      </PageShell>
    );
  if (!providers.list.data || !entry)
    return (
      <PageShell backButton={back} title={title}>
        <p className="text-destructive text-sm" role="alert">
          {providers.list.data ? `${name} isn't connected.` : LIST_FAILED}
        </p>
      </PageShell>
    );
  const list = providers.list.data;
  return (
    <PageShell
      backButton={back}
      description={
        changesInPlace
          ? "OpenBot checks the connection before it switches. Nothing changes if the check fails."
          : "OpenBot checks the connection before it saves it. Nothing changes if the check fails."
      }
      title={title}
    >
      <ChooserCard>
        <ChooseConnection
          connection={changesInPlace ? (current.data ?? undefined) : undefined}
          mode={
            changesInPlace
              ? {
                  kind: "organization",
                  inDesktop: providers.inDesktop,
                  organizationWide: providers.organizationWide,
                  ...(retired ? { provider: entry.provider } : {}),
                }
              : {
                  kind: "adding",
                  scope,
                  signIns: list.signIns,
                  connected: list.connections,
                  owner: providers.owner,
                  provider: entry.provider,
                  login: entry.login,
                  reconnecting: name,
                }
          }
          onBack={() => void navigate(paths.provider(id, scope))}
          onConnected={(next) => {
            if (next.desktopProblem) {
              setDone(next);
              return;
            }
            void navigate(
              paths.provider(
                next.connection.provider ?? id,
                scope,
                next.isDefault === false ? "added" : "in-use",
              ),
            );
          }}
        />
      </ChooserCard>
    </PageShell>
  );
}
