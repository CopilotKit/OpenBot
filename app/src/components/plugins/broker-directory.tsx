import { IconKey, IconPlug, IconSearch } from "@tabler/icons-react";
import {
  type UseInfiniteQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import type { ConnectInNewTab } from "@/components/plugins/connect-in-new-tab";
import { KeyVersionLine } from "@/components/plugins/key-version";
import { AppInitial, LOGO_TILE } from "@/components/plugins/plugin-logo";
import {
  type DirectoryPressMode,
  useDirectoryPress,
} from "@/components/plugins/use-directory-press";
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
import { myAppRequestsQueryOptions } from "@/lib/app-access/queries";
import {
  appsQueryOptions,
  type DirectoryApp,
  type DirectoryAppPage,
  directoryAppPagesQueryOptions,
  directorySlug,
} from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { useAppsOpen } from "@/lib/enterprise/apps-open";
import { failureSaid, loadFailure } from "@/lib/load-failure";
import { useManagePaths } from "@/lib/manage-paths";
import {
  type DirectoryAppState,
  directoryAppState,
  directoryConnect,
} from "@/lib/plugins/directory-state";
import {
  consentBreadth,
  coverageWarning,
  keyNeededLine,
} from "@/lib/plugins/enablement-notes";
import {
  directoryDescriptions,
  directoryReadFailure,
  type PluginsProvider,
  providerVocabulary,
} from "@/lib/plugins/provider-vocabulary";
import { connectionsQueryOptions } from "@/lib/plugins/queries";

/**
 * The active broker's directory, searched rather than listed.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is a directory nobody here has reviewed, which is why it is a
 * search field and not a list: the only sensible entry point into a directory that size is the name
 * of the app you already came looking for.
 *
 * Adding one is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own mail or messages readable.
 *
 * ONE PRESS, WHEREVER IT IS OPENED. Somebody who may add apps (the personal edition's one person, or
 * an admin of their organization, which is OpenBot Cloud's usual case) presses Connect: the app is
 * added for everybody and their own sign-in or key form follows on the same press, from Connections
 * and from Admin alike. Admin's Browse apps used to stop at "Add", and the row then asked for a
 * second press to Connect; "turn it on, then connect it" was a step nobody read as one. With apps
 * open a member connects in the same press; locked down, a member asks an admin for it. `place`
 * decides only where the back button and the app's page go.
 *
 * A COMPONENT AND NOT A ROUTE, so every directory route is the same screen rather than several that
 * drift. A route file importing another route file is how that drift starts, so none does. Every
 * vendor word is read from {@link providerVocabulary}; nothing here spells a vendor, and nothing
 * here branches on which one it is — a `provider === "composio"` test inside a screen is the same
 * mistake wearing a conditional.
 */
/** Placeholder rows while the directory loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

/** Where the directory was opened from: a person's Connections, or Admin's Apps. */
export type DirectoryPlace = "connections" | "admin";

/**
 * What a press does for this person, opened from `place`. Admin is opened only by an admin, so
 * there it is always Connect. With apps open (`open`, the organization's switch) a member connects
 * too; locked down, a member asks an admin.
 */
export function directoryPressMode(input: {
  edition: "team" | "personal";
  place: DirectoryPlace;
  role: string | null | undefined;
  open?: boolean;
}): DirectoryPressMode {
  if (input.edition === "personal" || input.place === "admin") return "connect";
  return isOrganizationAdmin(input.role) || input.open === true
    ? "connect"
    : "request";
}

export function BrokerDirectory({
  provider,
  place = "admin",
}: {
  provider: PluginsProvider;
  place?: DirectoryPlace;
}) {
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

  /*
   * A page at a time: the first as soon as it comes, the next as the person scrolls toward the end
   * (`MoreWhenSeen`). Reading every page before drawing any kept this screen on its placeholders
   * for a quarter of a minute.
   */
  const apps = useInfiniteQuery(directoryAppPagesQueryOptions(query));
  const personal = paths.edition === "personal";
  const role = useQuery(currentUserQueryOptions()).data?.role;
  const open = useAppsOpen();
  const mode = directoryPressMode({
    edition: paths.edition,
    place,
    role,
    open,
  });
  /** From Connections the app's page is under Connections, in either edition. */
  const ownPages = personal || place === "connections";
  /*
   * WHETHER EACH ADDED APP IS CONNECTED, which the directory itself cannot say: it knows an app is
   * added, and adding records the app without signing anybody in to it. These are the reads the
   * Connections list and the app's page answer the same question from.
   */
  const plugins = useQuery(appsQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  /** A member's own requests still waiting, so a row they asked for reads "Requested". */
  const mine = useQuery(myAppRequestsQueryOptions(mode === "request"));
  const requested = new Set((mine.data ?? []).map((request) => request.appKey));
  const press = useDirectoryPress(mode);
  const { tab, signingIn } = press;
  const { waiting } = tab;
  /*
   * In the order the server answers, which is the order this screen draws (apps you sign in to
   * first, then apps that take a key, each by title). Sorting here instead would move rows already
   * on screen each time a page arrived.
   */
  const listed = apps.data?.pages.flatMap((page) => page.apps) ?? [];
  /** How many the whole list holds; counted from the rows only once they are all here. */
  const total =
    apps.data?.pages[0]?.total ?? (apps.hasNextPage ? null : listed.length);
  const stateOf = (entry: DirectoryApp) =>
    directoryAppState(entry, {
      servers: plugins.data,
      connections: connections.data?.connections,
    });

  /*
   * WHERE AN ADDED KEY VERSION'S PAGE IS, beside the sign-in it was offered under. Its key form opens
   * on arrival while this person hasn't connected it, as Connect on a key app's own row does.
   */
  const keyVersionLink = (keyAppId: string | null): LinkOptions | null => {
    if (keyAppId === null) return null;
    if (!ownPages) return paths.plugin(keyAppId);
    const keyState = directoryAppState(
      { appId: keyAppId, connectsWith: "key" },
      { servers: plugins.data, connections: connections.data?.connections },
    );
    return {
      to: "/connections/$key",
      params: { key: keyAppId },
      ...(keyState.kind === "not_connected"
        ? { search: { connect: true } }
        : {}),
    };
  };

  const signedIn =
    signingIn !== null &&
    listed.some(
      (entry) => entry.id === signingIn && stateOf(entry).kind === "connected",
    );
  const { signedIn: endSignIn } = press;
  React.useEffect(() => {
    if (signedIn) endSignIn();
  }, [signedIn, endSignIn]);
  const description = directoryDescriptions(
    personal
      ? "personal"
      : place === "admin"
        ? "team"
        : mode === "request"
          ? "request"
          : "connect",
  );

  return (
    <PageShell
      backButton={
        place === "connections"
          ? { label: "Connections", linkProps: { to: "/connections" } }
          : { label: paths.pluginsLabel, linkProps: paths.plugins() }
      }
      description={description.page}
      title={directoryLabel}
    >
      <PageSection description={description.search} title="Apps">
        {press.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failureSaid(press.error)}
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
         * Pending, error, empty, rows. Pending draws placeholder rows until the first page comes,
         * since a bare search box over blank space read as a page with nothing on it. They assert
         * nothing, so no sentence claims anything mid-fetch. The error is the first page's: a later
         * page that fails keeps the rows already here and says so under them (`MoreWhenSeen`).
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
        ) : apps.data === undefined ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {/*
             * The server's own sentence, as the enable failure above already does. A keyless
             * deployment is refused with one naming the key's environment variable, and that name is
             * the single thing an operator who reached this URL needs to read; the derived line
             * stays as the fallback for a failure that arrived carrying no message of its own.
             */}
            {loadFailure(
              apps.error,
              apps.error.message || directoryReadFailure(provider),
            )}
          </p>
        ) : listed.length === 0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconPlug}
            title={query ? "No matches" : "No apps"}
          >
            {query
              ? `No app matches "${query}".`
              : "No apps to show yet. Try again in a moment."}
          </PageEmpty>
        ) : (
          <>
            {/*
             * How many there are, before the list: with no search, this is the whole directory,
             * counted by the server across every page rather than by the rows read so far.
             */}
            <p className="mt-4 text-muted-foreground text-xs">
              {query
                ? total === null
                  ? null
                  : `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`
                : total === null
                  ? "Search by name to narrow them."
                  : `${total.toLocaleString()} apps. Search by name to narrow them.`}
            </p>
            <PageRows className="mt-2">
              {listed.map((entry, index) => {
                // One mutation serves every row, so which rows are mid-request is tracked beside it
                // rather than read off it (`useDirectoryPress`).
                const isAdding = press.adding.has(entry.id);
                const slug = directorySlug(entry.id) ?? entry.id;
                const state = stateOf(entry);
                const mine = signingIn === entry.id;

                return (
                  <React.Fragment key={entry.id}>
                    {/* The test id names the screen, not the vendor: this module draws whichever
                      broker is active, and the id is not user-visible. */}
                    <Item
                      data-testid={`directory-${directorySlug(entry.id) ?? entry.id}`}
                      size="sm"
                    >
                      {/* The vendor's own mark where the broker supplies one, and its initial where it
                        does not, so a list of third parties still has a fixed left edge. */}
                      <ItemMedia
                        variant={entry.logo ? "image" : "icon"}
                        className={entry.logo ? LOGO_TILE : undefined}
                      >
                        {entry.logo ? (
                          <img alt="" src={entry.logo} />
                        ) : (
                          <AppInitial name={entry.title} />
                        )}
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{entry.title}</ItemTitle>
                        <ItemDescription>{entry.summary}</ItemDescription>
                        <KeyNeededNote app={entry} />
                        {entry.appId !== null ? null : (
                          <CoverageNote app={entry} />
                        )}
                        {entry.appId !== null ? null : (
                          <BreadthNote app={entry} />
                        )}
                        {entry.keyVersion ? (
                          <KeyVersionLine
                            keyVersion={entry.keyVersion}
                            link={keyVersionLink(entry.keyVersion.appId)}
                            mode={mode}
                            onPress={() => press.pressKey(entry)}
                            pending={press.addingKey.has(entry.id)}
                          />
                        ) : null}
                        {mine ? (
                          <SignInNote name={entry.title} tab={tab} />
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
                         * offering to add it again. A second add would ask the server to record an
                         * app it already holds, and there is nothing on the row to suggest that
                         * would be harmless.
                         */}
                        {state.kind === "addable" && mode === "request" ? (
                          requested.has(slug) ? (
                            <span className="text-muted-foreground text-xs">
                              Requested
                            </span>
                          ) : (
                            <Button
                              aria-label={`Request ${entry.title}`}
                              disabled={press.requesting.has(slug)}
                              onClick={() => press.press(entry)}
                              size="sm"
                              variant="outline"
                            >
                              {press.requesting.has(slug)
                                ? "Requesting…"
                                : "Request"}
                            </Button>
                          )
                        ) : state.kind === "addable" ? (
                          /*
                           * Connect, never Add: the press adds the app and goes straight on to this
                           * person's own sign-in or key form (`useDirectoryPress`).
                           */
                          <Button
                            aria-label={
                              isAdding ? undefined : `Connect ${entry.title}`
                            }
                            disabled={isAdding || (mine && tab.pending)}
                            onClick={() => press.press(entry)}
                            size="sm"
                            variant="outline"
                          >
                            {isAdding ? "Connecting…" : "Connect"}
                          </Button>
                        ) : (
                          <DirectoryRowState
                            connectLink={
                              directoryConnect(entry) === "key" &&
                              state.kind === "not_connected"
                                ? ownPages
                                  ? {
                                      to: "/connections/$key",
                                      params: { key: state.serverId },
                                      search: { connect: true },
                                    }
                                  : paths.plugin(state.serverId)
                                : null
                            }
                            name={entry.title}
                            onConnect={
                              state.kind === "not_connected"
                                ? () => press.connect(entry.id, state.serverId)
                                : undefined
                            }
                            opening={mine && tab.pending}
                            personal={ownPages}
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
            <MoreWhenSeen
              failure={directoryReadFailure(provider)}
              pages={apps}
            />
          </>
        )}
      </PageSection>
      {/* OpenBot's step before a sign-in, in OpenBot Desktop's window. */}
      {tab.consentStep}
    </PageShell>
  );
}

/**
 * The next page of the directory, asked for as the end of the list comes into view.
 *
 * Nothing to see while it works: the rows simply continue. A margin below the view asks a little
 * before the person reaches the end, so the rows are usually there when they do, and a screen
 * taller than one page fills itself, since the end is in view as soon as a page lands. A page that
 * fails keeps every row already here, says so beneath them, and offers to try again.
 */
function MoreWhenSeen({
  pages,
  failure,
}: {
  pages: Pick<
    UseInfiniteQueryResult<{ pages: DirectoryAppPage[] }>,
    | "data"
    | "hasNextPage"
    | "isFetchingNextPage"
    | "isFetchNextPageError"
    | "fetchNextPage"
    | "error"
  >;
  /** What to say when a page fails and the server said nothing of its own. */
  failure: string;
}) {
  const end = React.useRef<HTMLDivElement>(null);
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    error,
  } = pages;
  /*
   * Watched afresh each time a page lands. An observer reports only a change, so one left in place
   * says nothing when the end is still in view after the rows grew, and the list would stop short
   * on a tall screen.
   */
  const landed = pages.data?.pages.length ?? 0;

  React.useEffect(() => {
    const element = end.current;
    if (
      !element ||
      landed === 0 ||
      !hasNextPage ||
      isFetchingNextPage ||
      isFetchNextPageError ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false });
      },
      { rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    landed,
  ]);

  if (!hasNextPage) return null;
  if (isFetchNextPageError)
    return (
      <div className="mt-4 flex flex-col items-start gap-3">
        <p className="text-destructive text-sm" role="alert">
          {loadFailure(error, error?.message || failure)}
        </p>
        <Button
          onClick={() => void fetchNextPage()}
          size="sm"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  return <div aria-hidden="true" data-testid="directory-more" ref={end} />;
}

/**
 * "Needs a key from 1Password" on an app that takes a key typed in, so nobody who expected a
 * sign-in is surprised at Connect. Drawn whether or not the app is added: the person connecting
 * reads this list too. Draws nothing for an app you sign in to.
 */
export function KeyNeededNote({ app }: { app: DirectoryApp }) {
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
export function CoverageNote({ app }: { app: DirectoryApp }) {
  const warning = coverageWarning(app);
  if (!warning) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="coverage-warning">
      {warning}
    </p>
  );
}

/** The breadth line on a row, shown before Add is pressed. Draws nothing when there is none. */
export function BreadthNote({ app }: { app: DirectoryApp }) {
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
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
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
