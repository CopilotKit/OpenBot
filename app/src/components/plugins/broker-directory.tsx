import { IconKey, IconPlug, IconSearch } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  type ConnectInNewTab,
  useConnectInNewTab,
} from "@/components/plugins/connect-in-new-tab";
import { AppInitial } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useManagePaths } from "@/lib/manage-paths";
import {
  consentBreadth,
  coverageWarning,
  keyNeededLine,
  matchingApps,
} from "@/lib/plugins/enablement-notes";
import {
  enableComposioAppMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  directoryDescriptions,
  directoryReadFailure,
  type PluginsProvider,
  providerVocabulary,
} from "@/lib/plugins/provider-vocabulary";
import {
  type DirectoryAppState,
  directoryAppState,
  directoryConnect,
} from "@/lib/plugins/directory-state";
import {
  type ComposioApp,
  composioAppsQueryOptions,
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * The active broker's directory, searched rather than listed.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is a directory nobody here has reviewed, which is why it is a
 * search field and not a list: the only sensible entry point into a directory that size is the name
 * of the app you already came looking for.
 *
 * Adding one is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable. In the
 * personal edition Add goes straight on to that connection; in the team edition it is each
 * person's own step, and every added row says whether the person looking has taken it.
 *
 * A COMPONENT AND NOT A ROUTE, so both directory routes are the same screen rather than two that
 * drift. A route file importing another route file is how that drift starts, so neither does. Every
 * vendor word is read from {@link providerVocabulary}; nothing here spells a vendor, and nothing
 * here branches on which one it is — a `provider === "composio"` test inside a screen is the same
 * mistake wearing a conditional.
 */
/** Placeholder rows while the directory loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

export function BrokerDirectory({ provider }: { provider: PluginsProvider }) {
  // The provider's client, which is the app's own one; a screen mounted under another is refetched there.
  const queryClient = useQueryClient();
  const paths = useManagePaths();
  const { directoryLabel } = providerVocabulary(provider);
  const [search, setSearch] = React.useState("");
  /*
   * Debounced, as on People, and for a stronger reason: every distinct term is a cache key of its
   * own and a request to the vendor, so typing a name un-debounced is a round trip per keystroke
   * against somebody else's rate limit.
   */
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const apps = useQuery(composioAppsQueryOptions(query, provider));
  /*
   * WHAT A FAILED ADD SAID, KEPT WHERE A SECOND ADD CANNOT ERASE IT.
   *
   * ONE OBSERVER SERVES EVERY BUTTON, which is what `enable.variables` below is already written
   * around — and the same fact makes `enable.error` unusable as the place a refusal lives.
   * `MutationObserver.mutate` does `this.#currentMutation?.removeObserver(this)` and rebuilds, so
   * `error`, `isPending` and `variables` describe ONLY the most recent press. An admin pressing Add
   * on Slack and then, a beat later, on Gmail watched Slack's row revert from "Adding…" to "Add"
   * with its request still in flight — and when Slack came back 409, or 503, or carrying the
   * vendor's own sentence about a bad key, the banner never showed it, because `enable.error` was
   * Gmail's and Gmail's was null. What was left was a row saying "Add" and no record of a failure.
   *
   * THE MUTATION-LEVEL `onError` STILL FIRES AFTER `removeObserver`, which is why this works and
   * reading the observer does not. It is the shape the sibling grant screen already uses
   * (`plugin-bot-page.tsx`), arriving at the one screen that was reading the observer instead.
   */
  const [enableError, setEnableError] = React.useState<string | null>(null);
  /*
   * AND WHICH ROWS ARE IN FLIGHT, FOR THE SAME REASON AND OUT OF THE SAME HOOKS.
   *
   * `enable.isPending && enable.variables?.slug === entry.slug` is the observer again: it names the
   * most recent press and no other, so pressing Add on a second app put the FIRST row back to "Add"
   * with its request still open — an invitation to press it again, which asks the server to enable
   * an app it is already enabling. A set of slugs is what survives the rebuild, added in `onMutate`
   * and removed in `onSettled` so it drains on a refusal exactly as it does on a success.
   */
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set());
  const personal = paths.edition === "personal";
  /*
   * WHETHER EACH ADDED APP IS CONNECTED, which the directory itself cannot say: it knows an app is
   * added, and adding records the app without signing anybody in to it. These are the reads the
   * Connections list and the app's page answer the same question from.
   */
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  /*
   * ONE SIGN-IN AT A TIME, IN A NEW TAB, the way a Bot's Connect card starts one
   * (`AppAccessAction`). `signingIn` names the row it is for, so only that row says it is waiting.
   */
  const tab = useConnectInNewTab();
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  const navigate = useNavigate();
  const enable = useMutation({
    ...enableComposioAppMutationOptions(queryClient),
    onMutate: (input: { slug: string }) => {
      setEnableError(null);
      setAdding((held) => new Set(held).add(input.slug));
    },
    onError: (thrown: Error) => setEnableError(thrown.message),
    /*
     * SPELLED OUT RATHER THAN INHERITED, because the spread above carries an `onSettled` of its own
     * — `invalidatePlugins` — and a second one here replaces it rather than running beside it. The
     * refetch is what turns the added row into its connection state, so dropping it would leave the list claiming
     * the app is still addable until something else invalidated.
     */
    onSettled: (_data, _error, input) => {
      setAdding((held) => {
        const left = new Set(held);
        left.delete(input.slug);
        return left;
      });
      return invalidatePlugins(queryClient);
    },
  });
  const listed = matchingApps(apps.data?.apps ?? []);
  const stateOf = (entry: ComposioApp) =>
    directoryAppState(entry, {
      provider,
      servers: plugins.data?.servers,
      connections: connections.data?.connections,
    });

  /*
   * WATCHED WHILE THE SIGN-IN IS OPEN in the other tab: the connections are read again every two
   * seconds until the row reads connected, and then the wait ends. Coming back from the tab proves
   * nothing, so the server is what is asked.
   */
  const { waiting, stopWaiting } = tab;
  React.useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: connectionsQueryOptions().queryKey,
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting, queryClient]);
  const signedIn =
    signingIn !== null &&
    listed.some(
      (entry) =>
        entry.slug === signingIn && stateOf(entry).kind === "connected",
    );
  React.useEffect(() => {
    if (!signedIn) return;
    stopWaiting();
    setSigningIn(null);
  }, [signedIn, stopWaiting]);

  /*
   * An app that turned out to take a key goes to its page with the key form open: there is no
   * sign-in page to send anybody to.
   */
  const openKeyForm = React.useCallback(
    (serverId: string) =>
      void navigate({
        to: "/connections/$key",
        params: { key: serverId },
        search: { connect: true },
      }),
    [navigate],
  );
  const signingInServer = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!tab.needsKey || !signingInServer.current) return;
    if (personal) openKeyForm(signingInServer.current);
  }, [tab.needsKey, personal, openKeyForm]);

  /** Start this person's own sign-in to an app that is already added. */
  const connect = (slug: string, serverId: string) => {
    setEnableError(null);
    stopWaiting();
    setSigningIn(slug);
    signingInServer.current = serverId;
    tab.open(serverId);
  };

  /*
   * ADD, AND IN THE PERSONAL EDITION GO STRAIGHT ON TO CONNECTING. The one person is also the admin,
   * so adding an app and signing in to it are one decision. An app that signs in opens its sign-in in
   * a new tab on the same press (the tab is claimed on the click, before the app is added, or the
   * browser blocks it). An app that takes a key opens its page with the key form. In the team
   * edition Add stays the admin's act for everybody, and the row then says the admin's own account
   * isn't connected.
   */
  const add = (entry: ComposioApp) => {
    const how = directoryConnect(entry);
    if (personal && how === "sign-in") {
      stopWaiting();
      setSigningIn(entry.slug);
      signingInServer.current = null;
      tab.openAfter(async () => {
        const serverId = await enable.mutateAsync({ slug: entry.slug });
        signingInServer.current = serverId;
        return serverId;
      });
      return;
    }
    if (personal && how === "key") {
      enable.mutateAsync({ slug: entry.slug }).then(openKeyForm, () => {
        // Said by the mutation's own `onError`.
      });
      return;
    }
    enable.mutate({ slug: entry.slug });
  };
  const tabError = signingIn ? tab.error : null;

  return (
    <PageShell
      backButton={{ label: paths.pluginsLabel, linkProps: paths.plugins() }}
      description={directoryDescriptions(paths.edition).page}
      title={directoryLabel}
    >
      <PageSection
        description={directoryDescriptions(paths.edition).search}
        title="Apps"
      >
        {enableError || tabError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {enableError ?? tabError}
          </p>
        ) : null}

        <Input
          aria-label="Search apps"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by app name"
          value={search}
        />

        {/*
         * Pending, error, empty, rows. Pending draws placeholder rows: the full directory takes a
         * couple of seconds to arrive, and a bare search box over blank space read as a page with
         * nothing on it. They assert nothing, so no sentence claims anything mid-fetch.
         */}
        {apps.isPending ? (
          <div aria-busy="true" aria-label="Loading apps" role="status">
            <PageRows>
              {LOADING_ROWS.map((key, index) => (
                <React.Fragment key={key}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <Skeleton className="size-full" />
                    </ItemMedia>
                    <ItemContent className="gap-1.5">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-64" />
                    </ItemContent>
                  </Item>
                </React.Fragment>
              ))}
            </PageRows>
          </div>
        ) : apps.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {/*
             * The server's own sentence, as the enable failure above already does. A keyless
             * deployment is refused with one naming the key's environment variable, and that name is
             * the single thing an operator who reached this URL needs to read; the derived line
             * stays as the fallback for a failure that arrived carrying no message of its own.
             */}
            {apps.error.message || directoryReadFailure(provider)}
          </p>
        ) : listed.length === 0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconPlug}
            title={query ? "No matches" : "No apps"}
          >
            {query
              ? `No app matches "${query}".`
              : "No apps to show yet. Reload the page to try again."}
          </PageEmpty>
        ) : (
          <>
            {/* How many there are, before the list: with no search, this is the whole directory. */}
            <p className="mt-4 text-muted-foreground text-xs">
              {query
                ? `${listed.length.toLocaleString()} ${listed.length === 1 ? "match" : "matches"}`
                : `${listed.length.toLocaleString()} apps. Search by name to narrow them.`}
            </p>
            <PageRows className="mt-2">
              {listed.map((entry, index) => {
                // One mutation serves every row, so which rows are mid-request is tracked beside it
                // rather than read off it. See `adding` above.
                const isAdding = adding.has(entry.slug);
                const state = stateOf(entry);
                const mine = signingIn === entry.slug;

                return (
                  <React.Fragment key={entry.slug}>
                    {/* The test id names the screen, not the vendor: this module draws whichever
                      broker is active, and the id is not user-visible. */}
                    <Item data-testid={`directory-${entry.slug}`} size="sm">
                      {/* The vendor's own mark where the broker supplies one, and its initial where it
                        does not, so a list of third parties still has a fixed left edge. */}
                      <ItemMedia variant={entry.logo ? "image" : "icon"}>
                        {entry.logo ? (
                          <img alt="" src={entry.logo} />
                        ) : (
                          <AppInitial name={entry.name} />
                        )}
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{entry.name}</ItemTitle>
                        <ItemDescription>{entry.description}</ItemDescription>
                        <KeyNeededNote app={entry} />
                        {entry.enabled ? null : <CoverageNote app={entry} />}
                        {entry.enabled ? null : <BreadthNote app={entry} />}
                        {mine ? (
                          <SignInNote name={entry.name} tab={tab} />
                        ) : null}
                      </ItemContent>
                      <ItemActions>
                        {/* The size of the decision, stated before it is made: an app is not one
                          tool, and "167 actions" is what says so. */}
                        <span className="text-muted-foreground text-xs">
                          {entry.actionCount} actions
                        </span>
                        {/*
                         * An app this deployment already has says where it stands rather than
                         * offering Add again. A second Add would ask the server to record an app it
                         * already holds, and there is nothing on the row to suggest that would be
                         * harmless.
                         */}
                        {state.kind === "addable" ? (
                          <Button
                            disabled={isAdding || (mine && tab.pending)}
                            onClick={() => add(entry)}
                            size="sm"
                            variant="outline"
                          >
                            {isAdding ? "Adding…" : "Add"}
                          </Button>
                        ) : (
                          <DirectoryRowState
                            connectLink={
                              directoryConnect(entry) === "key" &&
                              state.kind === "not_connected"
                                ? personal
                                  ? {
                                      to: "/connections/$key",
                                      params: { key: state.serverId },
                                      search: { connect: true },
                                    }
                                  : paths.plugin(state.serverId)
                                : null
                            }
                            name={entry.name}
                            onConnect={
                              state.kind === "not_connected"
                                ? () => connect(entry.slug, state.serverId)
                                : undefined
                            }
                            opening={mine && tab.pending}
                            personal={personal}
                            state={state}
                            waiting={mine && waiting}
                          />
                        )}
                      </ItemActions>
                    </Item>
                    {index !== listed.length - 1 && <Separator />}
                  </React.Fragment>
                );
              })}
            </PageRows>
          </>
        )}
      </PageSection>
    </PageShell>
  );
}

/**
 * "Needs a key from 1Password" on an app that takes a key typed in, so nobody who expected a
 * sign-in is surprised at Connect. Drawn whether or not the app is added: the person connecting
 * reads this list too. Draws nothing for an app you sign in to.
 */
export function KeyNeededNote({ app }: { app: ComposioApp }) {
  const line = keyNeededLine(app);
  if (!line) return null;
  return (
    <p
      className="flex items-center gap-1 text-muted-foreground text-xs"
      data-testid="key-needed"
    >
      <IconKey aria-hidden="true" className="size-3.5 shrink-0" />
      {line}
    </p>
  );
}

/** The warning on a row, shown before Add is pressed. Draws nothing when there is none. */
export function CoverageNote({ app }: { app: ComposioApp }) {
  const warning = coverageWarning(app);
  if (!warning) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="coverage-warning">
      {warning}
    </p>
  );
}

/** The breadth line on a row, shown before Add is pressed. Draws nothing when there is none. */
export function BreadthNote({ app }: { app: ComposioApp }) {
  const breadth = consentBreadth(app);
  if (!breadth) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="breadth-note">
      {breadth}
    </p>
  );
}

/**
 * Where an added app stands, and the press that moves it on.
 *
 * "Not connected" with Connect beside it until this person's own account is connected, never
 * "Added" on its own: adding an app signs nobody in. The team edition says it is added too, since
 * there the admin added it for everybody and their own account is a separate step.
 */
function DirectoryRowState({
  state,
  name,
  personal,
  onConnect,
  connectLink,
  opening,
  waiting,
}: {
  state: Exclude<DirectoryAppState, { kind: "addable" }>;
  name: string;
  personal: boolean;
  onConnect: (() => void) | undefined;
  /** Where Connect goes for an app that takes a key: its page, with the key form. */
  connectLink: LinkOptions | null;
  opening: boolean;
  waiting: boolean;
}) {
  if (state.kind === "loading") return null;
  if (state.kind === "added")
    return <span className="text-muted-foreground text-xs">Added</span>;
  if (state.kind === "connected")
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        {/* Decorative: the word beside it already says which. */}
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-emerald-500"
        />
        Connected
      </span>
    );
  return (
    <>
      <span
        className="text-muted-foreground text-xs"
        data-testid="directory-not-connected"
      >
        {personal ? "Not connected" : "Added, not connected"}
      </span>
      {connectLink ? (
        <Button
          render={<Link {...connectLink} />}
          aria-label={`Connect ${name}`}
          size="sm"
          variant="outline"
        >
          Connect
        </Button>
      ) : (
        <Button
          aria-label={opening || waiting ? undefined : `Connect ${name}`}
          disabled={opening}
          onClick={onConnect}
          size="sm"
          variant="outline"
        >
          {waiting
            ? `Waiting for ${name}…`
            : opening
              ? "Opening sign-in…"
              : "Connect"}
        </Button>
      )}
    </>
  );
}

/** Under the row whose sign-in is open: where to finish it, or the link when the tab was blocked. */
function SignInNote({ name, tab }: { name: string; tab: ConnectInNewTab }) {
  if (tab.blockedUrl)
    return (
      <p className="text-xs" role="status">
        This browser blocked the tab.{" "}
        <a
          className="underline underline-offset-2"
          href={tab.blockedUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open {name}'s sign-in
        </a>
        .
      </p>
    );
  if (tab.waiting)
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Finish signing in to {name} in the tab that opened.
      </p>
    );
  return null;
}
