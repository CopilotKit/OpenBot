import {
  IconApps,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconCheck,
  IconChevronRight,
  IconLock,
  IconPlug,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  type LinkOptions,
  linkOptions,
} from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { MovedAppsNotice } from "@/components/moves/moved-apps-notice";
import { directoryPressMode } from "@/components/plugins/broker-directory";
import { AppInitial, PluginLogo } from "@/components/plugins/plugin-logo";
import {
  type DirectoryPress,
  useDirectoryPress,
} from "@/components/plugins/use-directory-press";
import { providerIcon } from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { myAppRequestsQueryOptions } from "@/lib/app-access/queries";
import {
  appSetupQueryOptions,
  appsQueryOptions,
  catalogueQueryOptions,
  type DirectoryApp,
  directoryAppsQueryOptions,
} from "@/lib/apps/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { mayAddApps } from "@/lib/auth/roles";
import { useConnectApp } from "@/lib/connections/connect-app";
import { useOpenAppPage } from "@/lib/connections/open-app-page";
import {
  type ConnectionRow,
  catalogueToAddRows,
  connectionRows,
  directoryRows,
  needsReconnecting,
  personalConnectionRows,
} from "@/lib/connections/rows";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useAppsOpen } from "@/lib/enterprise/apps-open";
import {
  identityProvidersQueryOptions,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import { failureSaid, isHeld, loadFailure } from "@/lib/load-failure";
import { keyedLookup } from "@/lib/lookup";
import { useManagePaths } from "@/lib/manage-paths";
import { useReturnToReconnectList } from "@/lib/moves/use-moved-apps";
import {
  addedByUrlListedOn,
  brokeredAccountsListedOn,
  serversListedFor,
  sharedAccountsListedOn,
} from "@/lib/plugins/listed";
import {
  directoryProvider,
  directoryReadFailure,
  moreAppsRow,
} from "@/lib/plugins/provider-vocabulary";
import {
  connectionsQueryOptions,
  personalConnections,
} from "@/lib/plugins/queries";
import { searchTextEntry } from "@/lib/search-text";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/_app/connections/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. `?linked=` is the same for the GitHub account-link callback: `github` on
   * success, `github-taken` when that GitHub account belongs to another OpenBot user, `failed`
   * otherwise (see linked-notice.ts). Each is the only channel available: the callback is a
   * redirect from another company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   *
   * EACH IS READ AS TEXT WHATEVER THE ROUTER PARSED IT INTO (`searchText`): the router JSON-parses
   * search values, so a server key or reason code that happens to be digits or JSON-shaped arrives
   * as a number or an object, and a `typeof` guard would quietly turn the callback's report into
   * no report at all.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: string; authorized?: string; linked?: string } => ({
    ...searchTextEntry("connected", search.connected),
    /*
     * A CHANNEL OF ITS OWN, BESIDE `?connected=` AND NEVER FOLDED INTO IT. That one is the Composio
     * OAuth callback's and carries a server key or `failed`; this one is the brokered per-action
     * verifier's and carries a reason code. Two senders answering different questions on one
     * parameter is how a notice comes to be drawn for the wrong thing.
     */
    ...searchTextEntry("authorized", search.authorized),
    ...searchTextEntry("linked", search.linked),
  }),
});

/**
 * WHAT THE VERIFIER REFUSED, IN WORDS — AND THE WORDS LIVE HERE AND NOWHERE ELSE.
 *
 * THE SENTENCE NEVER TRAVELS IN THE URL. A message rendered from a query string is a message
 * anybody can author on this deployment's own origin: a link could be sent around carrying whatever
 * sentence its author liked, shown in this page's own voice under this deployment's own address.
 * What travels is an opaque code the server chose from a closed set, and this map is the only place
 * it becomes something a person reads — which is also what keeps one sentence from being maintained
 * in two places that drift apart.
 *
 * AN UNRECOGNISED CODE DRAWS NOTHING, deliberately. A code this build does not know is either
 * somebody probing the parameter or a deployment mid-upgrade, and a generic "something went wrong"
 * for both would be a sentence that tells a person nothing and an invitation to keep trying.
 *
 * A MAP, NOT AN OBJECT, BECAUSE THE KEY COMES OUT OF A URL. An object literal inherits from
 * `Object.prototype`, so an object lookup answers `toString`, `constructor` and `__proto__` with
 * members nobody put here — none of them nullish, so no `?? null` turns them back into "draws
 * nothing", and `Record<string, string>` says they cannot happen so the compiler never asks. What
 * reached the page was a function (an alert with nothing in it) or, for `__proto__`, an object,
 * which React refuses to draw: "Objects are not valid as a React child" took the whole Connected
 * accounts screen down for whoever opened the link. A `Map` holds only what was put in it, so the
 * unrecognised code and the borrowed member are once again the same case, by construction rather
 * than by a list of names to keep out.
 */
export const AUTHORIZATION_NOTICES: ReadonlyMap<string, string> = new Map([
  [
    "no-broker",
    "Connecting apps isn't set up yet, so nothing was recorded. Ask an admin to set it up.",
  ],
  [
    "not-supported",
    "Apps here connect once, with Connect on the app's page. They aren't authorized one action at a time.",
  ],
  [
    "missing-handle",
    "That link doesn't say which authorization it finishes, so nothing was done. Start again from the app's page.",
  ],
  [
    "no-attempt",
    "There's no authorization in progress for you to finish. It may have expired, or started in another session. Start again from the app's page.",
  ],
  [
    "vendor-unavailable",
    "The app didn't answer when OpenBot tried to finish that authorization, so nothing was recorded. Try the link again in a moment.",
  ],
  [
    "not-your-authorization",
    "That link doesn't match the authorization you have in progress, so nothing was recorded. Finish it in the tab you started it in, or start again from the app's page.",
  ],
  [
    "not-finished",
    "That authorization hasn't finished yet, so nothing was recorded. Finish it at the app, then open the link again.",
  ],
  [
    "authorization-failed",
    "The app didn't complete that authorization, so nothing was recorded. Start again from the app's page.",
  ],
  [
    "context-changed",
    "That app's account changed while the authorization was open, so nothing was recorded. Access given to the old account was removed. Start again from the app's page.",
  ],
  [
    "name-changed",
    "That authorization was started before an update changed how OpenBot signs you in to the app, so nothing was recorded. Press Connect on the app's page to start again.",
  ],
  [
    "not-permitted",
    "You can't connect that app's account anymore, so nothing was recorded. Your access or the app's setup changed while the authorization was open. Ask an admin if you expected to finish it.",
  ],
  [
    "cancelled",
    "That authorization was cancelled while it was being finished, so nothing was recorded. The access it gave was removed.",
  ],
  [
    "cancelled-left-live",
    "That authorization was cancelled while it was being finished, so nothing was recorded. The access it gave couldn't be removed, so the app may still allow the action you cancelled. To remove it, disconnect the app from its page, then connect again and authorize only what you want.",
  ],
  [
    "not-recorded",
    "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or ask an admin if it keeps happening.",
  ],
]);

/**
 * The personal edition's words for the codes whose team sentence sends somebody to an admin. It has
 * one person and no admin: they set connecting apps up themselves (Settings, Setup), and nobody else
 * changes what they can reach. Every other code reads the same in both editions.
 */
export const PERSONAL_AUTHORIZATION_NOTICES: ReadonlyMap<string, string> =
  new Map([
    [
      "no-broker",
      "Connecting apps isn't set up yet, so nothing was recorded. Set it up in Settings under Setup.",
    ],
    [
      "not-permitted",
      "You can't connect that app's account anymore, so nothing was recorded. The app's setup changed while the authorization was open. Start again from the app's page.",
    ],
    [
      "not-recorded",
      "Couldn't record that authorization, so nothing was saved. Start again from the app's page, or check OpenBot's logs if it keeps happening.",
    ],
  ]);

/** The sentence for a code the verifier sent back, or null for one this build does not know. */
export function authorizationNoticeFor(
  authorized: string | undefined,
  edition: "team" | "personal" = "team",
): string | null {
  if (!authorized) return null;
  const team = keyedLookup(AUTHORIZATION_NOTICES, authorized) ?? null;
  if (team === null || edition !== "personal") return team;
  return keyedLookup(PERSONAL_AUTHORIZATION_NOTICES, authorized) ?? team;
}

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: ReadonlyMap<
  string,
  React.ComponentType<{ className?: string }>
> = new Map([
  ["google-drive", IconBrandGoogleDrive],
  ["notion", IconBrandNotion],
]);

/* A Map for the same reason the notices above are one: a lookup answers with what was put in it and
 * nothing a plain object would have inherited, so a catalogue key called `toString` draws the
 * fallback mark rather than handing React `Object.prototype.toString` to render as a component.
 * The read goes through `keyedLookup` so the rule has one home rather than one comment per page;
 * see `app/src/lib/lookup.ts`. A missing key draws the app's initial, in `ConnectionMark`. */
const markFor = (key: string) => keyedLookup(MARKS, key);

function RouteComponent() {
  const { connected: outcome, authorized, linked } = Route.useSearch();
  /*
   * ALL THREE READ ONCE HERE, AND ALL THREE DROPPED FROM THE URL BELOW — not just `?linked=`.
   *
   * Every parameter this screen accepts is a report of something that has already happened: the
   * Composio callback's `?connected=`, the brokered verifier's `?authorized=` and the GitHub
   * account-link callback's `?linked=`. A report is news exactly once. Left in the address bar it
   * is read again on every reload and on every back-navigation, so a failure that is minutes old
   * is redrawn as though it had just happened — somebody is told again that their account could
   * not be connected, or that there is no authorization in progress, about an attempt they have
   * since finished successfully. Only `?linked=` was ever cleaned, which is how the other two came
   * to replay.
   *
   * THE SNAPSHOT IS WHAT THE PAGE DRAWS FROM, and it is why the strip can be unconditional. Read
   * live off the search, the notice would vanish the instant the parameter did; held here, the
   * sentence outlives the URL it arrived in. That is what `?linked=` was already doing, and the
   * other two now do it for the same reason rather than by accident.
   */
  /*
   * The verifier's CODE is what is held, not its sentence: the sentence depends on the edition, and
   * the edition may not have been read yet on the first render.
   */
  const [arrival] = React.useState(() => ({
    outcome,
    authorized,
    linked: linkedNotice(linked),
  }));
  /* The same cached list the Linked accounts section reads, so a Disconnect there retracts a success here. */
  const links = useQuery(linkedAccountsQueryOptions());
  const providers = useQuery(identityProvidersQueryOptions());
  const notice = visibleLinkedNotice(arrival.linked, links.data);
  const navigate = Route.useNavigate();
  /*
   * ONE NAVIGATE FOR ALL THREE, never one per parameter. `search` replaces the whole object, so two
   * effects each dropping their own key race: whichever lands second rebuilds from a snapshot taken
   * before the first, and puts the key the first had just removed back.
   */
  React.useEffect(() => {
    if (
      outcome === undefined &&
      authorized === undefined &&
      linked === undefined
    ) {
      return;
    }
    navigate({
      search: ({ connected: _c, authorized: _a, linked: _l, ...rest }) => rest,
      replace: true,
    });
  }, [outcome, authorized, linked, navigate]);
  /*
   * A browser's sign-in can come back here (`?connected=<key>`): an app opened from the reconnect
   * list goes back to the list once it is connected. `?connected=failed` connects nothing, so the
   * person stays here with the failure said, and the notice below is the way back to the list.
   */
  useReturnToReconnectList();
  const [search, setSearch] = React.useState("");
  const apps = useQuery(appsQueryOptions());
  const catalogue = useQuery(catalogueQueryOptions());
  const setup = useQuery(appSetupQueryOptions());
  /* The three reads the apps on this page come from, waited for and failed together. */
  const appReads = [apps, catalogue, setup];
  const appsError = appReads.find((read) => read.error)?.error ?? null;
  const appsFetching = appReads.some((read) => read.isFetching);
  const connections = useQuery(connectionsQueryOptions());

  /*
   * ONLY THE PERSON'S OWN. A Shared app's row is the deployment's, not this person's, and the
   * "Connected" badge this set feeds would otherwise tell them they hold an account they don't.
   */
  const connected = new Set(
    personalConnections(connections.data?.connections ?? []).map(
      (row) => row.serverId,
    ),
  );
  /* Of those, the ones to reconnect: their tiles say Reconnect, and pressing one starts it. */
  const reconnect = new Set(
    personalConnections(connections.data?.connections ?? [])
      .filter(needsReconnecting)
      .map((row) => row.serverId),
  );
  const added = new Set((apps.data ?? []).map((s) => s.id));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (catalogue.data ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  /*
   * Brokered apps belong here for the same reason the OAuth ones do: they answer as you.
   *
   * The filter above names the catalogue's `user-oauth` kind, which a brokered row cannot have
   * because it has no catalogue entry at all — so the one connector that is nothing but per-person
   * accounts was the one this page never listed.
   *
   * EXCEPT THE ONES THAT NEED NO ACCOUNT, WHICH IS THE SAME RULE THE `user-oauth` FILTER ABOVE IS.
   * That one keeps out a vendor with a shared token because it "has nothing for you to decide"; a
   * Composio `NO_AUTH` app has exactly as little, one layer further in. There is no account to make:
   * connectApp refuses to create one and the call gate lets it through with no row, so
   * a row for it here can never turn green. What an admin enabling Hacker News put on every
   * person's page was a permanently grey "Not connected" that reads as an unfinished task, opening
   * a page that says the app needs no account and draws no button — the list and the page it opens
   * contradicting each other, with the list the more believable of the two.
   *
   * ASKED OF THE APP'S `connectsWith`, which this read already carries and the detail route already
   * consumes. Anything that is not `nothing` is an app somebody connects, one OpenBot couldn't read
   * included: such an app is far likelier to take a key or a sign-in, and dropping it here would
   * hide a connection somebody does have.
   */
  const listed =
    apps.data && setup.data
      ? serversListedFor({
          servers: apps.data,
          directoryAvailable: setup.data.directoryAvailable,
          directoryProvider: directoryProvider(setup.data),
        })
      : [];
  /*
   * THE PERSONAL EDITION LISTS EVERY APP HERE, added or not, because the one person is the one who
   * adds it: a tile's press adds the app and connects it in one go (`useConnectApp`).
   */
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  /** Undefined until it answers, and on a failed read: neither edition's guidance is assumed. */
  const edition = capabilities.data?.edition;
  const personal = edition === "personal";
  /*
   * A server added by its address is added for everyone in the organization, so only an admin adds
   * one (the personal edition's one person is its admin). Nobody else is offered a button the server
   * would refuse.
   */
  const role = useQuery(currentUserQueryOptions()).data?.role;
  /*
   * WHO ADDS AN APP, decided by the one rule the app has for it (`mayAddApps`: an owner or
   * an admin of the organization being worked in), which is the server's `admin` too. On OpenBot
   * Cloud that is usually the one person who made their own organization, and they add and connect
   * an app here in one press, never by way of Admin. With apps open (the organization's switch) a
   * member adds and connects in the same press; locked down, a member asks an admin for it.
   */
  const open = useAppsOpen();
  const openTeam = edition === "team" && open === true;
  const mayAdd = mayAddApps(personal, role) || openTeam;
  const mayAddServer = mayAdd;
  const connectApp = useConnectApp();
  const paths = useManagePaths();
  // The broker's directory of more apps, as one more tile, where a broker is set up.
  const provider = directoryProvider(setup.data);
  const directoryAvailable = setup.data?.directoryAvailable ?? false;
  const moreApps = moreAppsRow(provider, directoryAvailable, "personal");
  /*
   * IN BOTH EDITIONS, and in the team edition it opens Browse apps under Connections, never Admin's
   * copy: a member can't open Admin, and an admin opening it there adds an app for everybody without
   * connecting their own account.
   */
  const browse =
    edition !== undefined && moreApps.linked
      ? {
          title: moreApps.title,
          description: mayAdd
            ? moreApps.description
            : "Find more apps and ask an admin for them.",
        }
      : null;
  const browseLink =
    provider === "arcade"
      ? linkOptions({ to: "/connections/browse/arcade" })
      : linkOptions({ to: "/connections/browse/composio" });
  const authorizationNotice = authorizationNoticeFor(
    arrival.authorized,
    paths.edition,
  );
  const query = search.trim().toLocaleLowerCase();
  /*
   * THE SEARCH REACHES THE WHOLE DIRECTORY, not only what is on the page: the directory's own
   * search, asked once the typing settles (each distinct term is a request to the vendor), and
   * never with an empty term, so the page never reads all of it up front.
   */
  const [directoryTerm, setDirectoryTerm] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setDirectoryTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const searchesDirectory =
    edition !== undefined && directoryAvailable && query !== "";
  const directory = useQuery({
    ...directoryAppsQueryOptions(directoryTerm),
    enabled: searchesDirectory && directoryTerm !== "",
  });
  const pressMode = directoryPressMode({
    edition: edition ?? "team",
    place: "connections",
    role,
    open,
  });
  const press = useDirectoryPress(pressMode);
  const mine = useQuery(myAppRequestsQueryOptions(pressMode === "request"));
  const requested = new Set((mine.data ?? []).map((request) => request.appKey));
  const rows = personal
    ? personalConnectionRows({
        catalogue: catalogue.data ?? [],
        added,
        brokered: brokeredAccountsListedOn(listed),
        byUrl: addedByUrlListedOn(listed),
        connected,
        reconnect,
        links: links.data ?? [],
        providers: providers.data,
      })
    : connectionRows({
        catalogue: yours,
        brokered: brokeredAccountsListedOn(listed),
        shared: sharedAccountsListedOn(listed),
        byUrl: addedByUrlListedOn(listed),
        connected,
        reconnect,
        links: links.data ?? [],
        providers: providers.data,
      });
  const matching = rows.filter((row) =>
    `${row.title} ${row.summary}`.toLocaleLowerCase().includes(query),
  );
  /*
   * The personal edition answers two questions, one section each: what your Bots use, and what you
   * can add. Every app you could add is in the second, the ones that need a key included, and the
   * broker's directory is its last tile.
   */
  const yourApps = matching.filter((row) => row.state !== "available");
  /*
   * And with apps open in the team edition, the catalogue's apps nobody has added yet, which anybody
   * adds and connects in one press, as the personal edition's one person does.
   */
  const teamToAdd = openTeam
    ? catalogueToAddRows({ catalogue: catalogue.data ?? [], added, connected })
    : [];
  const toAdd = personal
    ? matching.filter((row) => row.state === "available")
    : teamToAdd.filter((row) =>
        `${row.title} ${row.summary}`.toLocaleLowerCase().includes(query),
      );
  /*
   * The directory's apps for this search that aren't on the page already, as tiles under Connect an app.
   * Read only while the answer is for what is typed now, so a tile never stands for an older term.
   */
  const directoryCurrent =
    searchesDirectory &&
    directoryTerm.toLocaleLowerCase() === query &&
    !directory.isPending &&
    !directory.error;
  const directoryEntries: DirectoryApp[] = directoryCurrent
    ? (directory.data ?? [])
    : [];
  const found = directoryRows({
    entries: directoryEntries,
    mayAdd,
    listed: new Set(
      [...rows, ...teamToAdd].map((row) => row.title.toLocaleLowerCase()),
    ),
    requested,
  });
  // Waiting on the directory for what is typed now: nothing claims "No matches" until it answers.
  const directoryWaiting =
    searchesDirectory &&
    (directoryTerm.toLocaleLowerCase() !== query || directory.isPending);
  /* The app whose sign-in this page opened, connected now: the wait ends. */
  const signingInApp = press.signingIn
    ? (apps.data ?? []).find(
        (server) => server.directoryEntryId === press.signingIn,
      )
    : undefined;
  const signedIn = signingInApp ? connected.has(signingInApp.id) : false;
  const { signedIn: endSignIn } = press;
  React.useEffect(() => {
    if (signedIn) endSignIn();
  }, [signedIn, endSignIn]);
  /*
   * The apps decide whether there is a list at all, and the account links only add to it: a failed
   * links read costs the GitHub and Slack rows and says so, not the whole page.
   */
  const loading =
    appReads.some((read) => read.isPending) ||
    connections.isPending ||
    links.isPending ||
    providers.isPending ||
    // Which rows there are depends on the edition, so the team list never flashes before the personal one.
    capabilities.isPending;
  /*
   * Whether there is a list to draw: apps here, or the directory to find more in. A new
   * organization with no apps yet still has its search and Browse apps.
   */
  const listable =
    !loading &&
    !appsError &&
    !connections.error &&
    (rows.length > 0 || teamToAdd.length > 0 || browse !== null);
  /*
   * A search that matches nothing, here or in the directory, says so once, with no section or
   * directory tile under it.
   */
  const nothingMatches =
    query !== "" &&
    matching.length === 0 &&
    toAdd.length === 0 &&
    found.length === 0 &&
    !directoryWaiting &&
    // A directory that couldn't be searched says so below; it isn't "No matches".
    !(searchesDirectory && directory.error);
  const showingApps = listable && !nothingMatches;

  return (
    <PageShell
      /*
       * The page's one verb: an MCP server OpenBot doesn't list, added by its address. Its own screen,
       * because it takes a name, an address and sometimes a key (the layout skill's Procedure 5).
       */
      action={
        mayAddServer ? (
          <Button
            render={(props) => <Link {...props} to="/connections/new" />}
            size="sm"
            variant="outline"
          >
            <IconPlus />
            Add custom MCP
          </Button>
        ) : undefined
      }
      className="@container"
      description={
        personal
          ? "Connect your accounts so your Bots can use apps on your behalf."
          : "Connect your accounts so Bots can use apps on your behalf."
      }
      title="Connections"
    >
      {/*
       * For `?connected=` only the failure is worth saying. A success needs no sentence: the row it
       * came back to now reads "Connected", which is the same news told by the thing it is news
       * about. `?linked=` is different and says both outcomes, through `linkedNotice` below.
       */}
      {arrival.outcome === "failed" ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Couldn't connect that account. Nothing was saved. Try again.
        </p>
      ) : null}
      {notice ? (
        notice.tone === "error" ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {notice.text}
          </p>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground" role="status">
            {notice.text}
          </p>
        )
      ) : null}
      {/*
       * The brokered per-action verifier's own channel. It lands here rather than on an app's page
       * because three of its refusals have no app to name, and a notice that sometimes appears one
       * level in and sometimes here would be a notice people learn to look for in two places.
       */}
      {authorizationNotice ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {authorizationNotice}
        </p>
      ) : null}
      {connectApp.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(connectApp.error)}
        </p>
      ) : null}
      {press.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failureSaid(press.error)}
        </p>
      ) : null}
      <SignInNote
        name={
          directoryEntries.find((entry) => entry.id === press.signingIn)
            ?.title ??
          signingInApp?.title ??
          "the app"
        }
        press={press}
      />
      {/* What a move to OpenBot Cloud left to connect again, and the way to the list of it. */}
      <MovedAppsNotice />
      {/*
       * The first section has no heading of its own: in the team edition it is the page's one list,
       * and "Your connections" under "Connections" said the same thing twice. It holds the search,
       * which filters every section under it. In the personal edition Your apps and Connect an app
       * follow as sections of their own.
       */}
      <PageSection>
        {/*
         * BOTH APP READS DECIDE THIS. Apps that loaded (listApps, the catalogue, getAppSetup) beside a
         * listConnections that failed would leave the `connected` set empty and every row
         * asserting "Connect" over accounts somebody already has, so either failure is one sentence:
         * nothing is listed rather than a list that may be wrong.
         */}
        {loading ? (
          <ConnectionsLoading />
        ) : appsError || connections.error ? (
          /*
           * A failed read is not missing setup, so Retry comes first. Only the team edition has an
           * admin to ask; a personal owner is pointed at Setup, which is theirs.
           */
          <div className="mt-4 flex flex-col items-start gap-3" role="alert">
            <p className="text-destructive text-sm">
              {loadFailure(
                [...appReads.map((read) => read.error), connections.error],
                edition === "team"
                  ? "Couldn't load your connections. Try again, or ask an admin if it keeps happening."
                  : edition === "personal"
                    ? "Couldn't load your connections. Try again, or check Setup if it keeps happening."
                    : "Couldn't load your connections. Try again.",
              )}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={appsFetching || connections.isFetching}
                onClick={() => {
                  for (const read of appReads)
                    if (read.error) void read.refetch();
                  if (connections.error) void connections.refetch();
                }}
                size="sm"
                variant="outline"
              >
                {appsFetching || connections.isFetching ? "Retrying…" : "Retry"}
              </Button>
              {edition === "personal" ? (
                <Button
                  render={<Link to="/settings/setup" />}
                  size="sm"
                  variant="ghost"
                >
                  Open Setup
                </Button>
              ) : null}
            </div>
          </div>
        ) : !listable ? (
          <PageEmpty
            action={
              edition === "personal" ? (
                <Button
                  render={<Link to="/settings/setup" />}
                  size="sm"
                  variant="outline"
                >
                  Open Setup
                </Button>
              ) : undefined
            }
            icon={IconPlug}
            title="No apps yet"
          >
            {openTeam
              ? "Apps show up here once they're added. Add one with Add custom MCP."
              : edition === "team"
                ? "Apps show up here once an admin turns them on."
                : edition === "personal"
                  ? "Apps show up here once OpenBot is set up to reach them."
                  : "Apps show up here once they're turned on."}
          </PageEmpty>
        ) : (
          <>
            <InputGroup className="h-9 border-transparent bg-muted/60 shadow-none dark:bg-muted/60">
              <InputGroupAddon>
                <IconSearch aria-hidden="true" className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search connections"
                placeholder="Search connections"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
            {nothingMatches ? (
              <PageEmpty icon={IconSearch} title="No matches">
                Nothing matches “{search.trim()}”.
              </PageEmpty>
            ) : personal || matching.length === 0 ? null : (
              <ConnectionGrid
                connectApp={connectApp}
                press={press}
                rows={matching}
              />
            )}
            {searchesDirectory && directory.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {loadFailure(directory.error, directoryReadFailure(provider))}
              </p>
            ) : null}
          </>
        )}
        {/*
         * OpenBot holding off (a move, a brief outage) is said once: when the list above already
         * says it, the same sentence is not said again for GitHub and Slack.
         */}
        {(links.error || providers.error) &&
        !(
          !loading &&
          (appsError || connections.error) &&
          isHeld([...appReads.map((read) => read.error), connections.error]) &&
          isHeld([links.error, providers.error])
        ) ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {loadFailure(
              [links.error, providers.error],
              "Couldn't load GitHub and Slack, so they aren't listed. Try again in a moment.",
            )}
          </p>
        ) : null}
      </PageSection>
      {showingApps && personal && yourApps.length > 0 ? (
        <PageSection title="Your apps">
          <ConnectionGrid
            connectApp={connectApp}
            press={press}
            rows={yourApps}
          />
        </PageSection>
      ) : null}
      {/*
       * Connect an app, in both editions: the apps you could add (the personal edition's catalogue), the
       * directory's matches for a search, and Browse apps last. In the team edition an admin's press
       * adds and connects, and so does everybody's with apps open; locked down, a member's asks an
       * admin.
       */}
      {showingApps && (toAdd.length + found.length > 0 || browse) ? (
        <PageSection title="Connect an app">
          <ConnectionGrid
            connectApp={connectApp}
            press={press}
            rows={[...toAdd, ...found]}
            directory={directoryEntries}
          >
            {browse ? <BrowseTile browse={browse} link={browseLink} /> : null}
          </ConnectionGrid>
        </PageSection>
      ) : null}
      {/* OpenBot's step before a sign-in, in OpenBot Desktop's window. */}
      {press.tab.consentStep}
      {/*
       * The rest of what a Bot signs in with. Saved logins and keys live in the Vault, under
       * Settings; this row is a way in from beside the apps that use them.
       */}
      <PageSection>
        <PageRows>
          <Item render={<Link to="/settings/vault" />} size="sm">
            <ItemMedia variant="icon">
              <IconLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Vault</ItemTitle>
              <ItemDescription>
                {personal
                  ? "Your saved logins and the keys your apps and models use."
                  : "Website logins you saved when signing a Bot in."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}

/**
 * Tiles two across, where every other list is one `PageRows` card of divided rows. The accepted
 * exception: connections are apps you pick out by their mark, so they are laid out as tiles rather
 * than read down as a list. In the personal edition, pressing a tile that is not in use connects or
 * adds it. `children` go after the tiles.
 */
function ConnectionGrid({
  rows,
  connectApp,
  press,
  directory = [],
  children,
}: {
  rows: ConnectionRow[];
  connectApp: ReturnType<typeof useConnectApp>;
  /** The press for a tile from the directory (`directoryEntryId`), shared with Browse apps. */
  press: DirectoryPress;
  /** The directory entries those tiles stand for. */
  directory?: readonly DirectoryApp[];
  children?: React.ReactNode;
}) {
  /*
   * RECONNECT IS ONE PRESS: the app's page opens with its connect started (the sign-in, or the key
   * form over a key the app didn't take), and the tile stays here saying Connecting… until that page
   * can draw. It used to open the page as it was, where a second press began it.
   */
  const appPage = useOpenAppPage();
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2">
      {rows.map((row) => {
        const entry = row.directoryEntryId
          ? directory.find((candidate) => candidate.id === row.directoryEntryId)
          : undefined;
        if (entry) {
          const pending =
            press.adding.has(entry.id) ||
            press.requesting.has(row.key) ||
            (press.signingIn === entry.id && press.tab.pending);
          return (
            <ConnectionItem
              key={`directory-${row.key}`}
              onPress={row.requested ? undefined : () => press.press(entry)}
              pending={pending}
              row={row}
            />
          );
        }
        // An app of the person's own to reconnect; a linked account (GitHub, Slack) opens its page.
        const reconnects =
          row.state === "needs_reconnect" && row.mark.kind !== "provider";
        return (
          <ConnectionItem
            key={row.key}
            onPress={
              reconnects
                ? () => void appPage.open(row.key, true)
                : row.state === "available" &&
                    (row.action === "connect" || row.action === "add")
                  ? () =>
                      void connectApp.run(
                        row.key,
                        row.action as "connect" | "add",
                      )
                  : undefined
            }
            pending={
              connectApp.pending === row.key || appPage.opening === row.key
            }
            row={row}
          />
        );
      })}
      {children}
    </div>
  );
}

/**
 * Under the notices, while a sign-in this page opened is out: where to finish it, or the link when
 * the browser blocked the tab. The tile itself has left the directory's matches by then.
 */
function SignInNote({
  press,
  name,
}: {
  press: DirectoryPress;
  /** The app the sign-in is for. */
  name: string;
}) {
  const { tab, signingIn } = press;
  if (!signingIn) return null;
  if (tab.blockedUrl)
    return (
      <p className="mt-4 text-sm" role="status">
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
      <p className="mt-4 text-muted-foreground text-sm" role="status">
        Finish signing in to {name} in the tab that opened.
      </p>
    );
  return null;
}

/**
 * The page's shape before the apps and your accounts have both answered: the search box and a grid
 * of tiles as tall as real ones. No tile says Connect or Connected until both reads are in, so an
 * account you have is never shown as one you don't.
 */
function ConnectionsLoading() {
  return (
    <div aria-label="Loading your connections" role="status">
      <div aria-hidden="true">
        <Skeleton className="h-9 w-full rounded-md bg-muted/60 motion-reduce:animate-none" />
        <div className="mt-4 grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2">
          {["a", "b", "c", "d"].map((key) => (
            <div
              className="flex min-h-14 items-center gap-3 rounded-lg border border-border bg-card px-3"
              key={key}
            >
              <Skeleton className="size-8 rounded-md motion-reduce:animate-none" />
              <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The broker's directory of more apps, as the last tile of Connect an app. */
function BrowseTile({
  browse,
  link,
}: {
  browse: { title: string; description: string };
  link: LinkOptions;
}) {
  return (
    <Item
      className="min-h-14 min-w-0 flex-nowrap gap-3 bg-card px-3 py-1.5"
      data-testid="account-browse"
      render={<Link {...link} />}
      size="sm"
      variant="outline"
    >
      <RowMark className="size-9">
        <IconApps className="size-4" />
      </RowMark>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-auto truncate">{browse.title}</ItemTitle>
        <ItemDescription className="line-clamp-1 text-xs">
          {browse.description}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * One connection: its mark, its name, one line, and where it stands. Opens its own page, or, given
 * `onPress`, is the press that connects it (the personal edition's Connect and Add).
 */
function ConnectionItem({
  row,
  onPress,
  pending = false,
}: {
  row: ConnectionRow;
  onPress?: () => void;
  pending?: boolean;
}) {
  return (
    <Item
      className="min-h-14 min-w-0 flex-nowrap gap-3 bg-card px-3 py-1.5 text-left"
      data-testid={
        row.directoryEntryId ? `directory-${row.key}` : `account-${row.key}`
      }
      /*
       * A tile asked for and waiting draws as a plain tile, like Shared account: nothing to press,
       * and never a disabled button, which faded the whole tile and its mark.
       */
      render={
        onPress ? (
          <button disabled={pending} onClick={onPress} type="button" />
        ) : row.requested ? undefined : (
          <Link params={{ key: row.key }} to="/connections/$key" />
        )
      }
      size="sm"
      variant="outline"
    >
      <RowMark className="size-9">
        <ConnectionMark mark={row.mark} name={row.title} />
      </RowMark>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="block w-auto truncate">{row.title}</ItemTitle>
        {row.summary ? (
          <ItemDescription
            className="line-clamp-1 break-all text-xs"
            title={row.summary}
          >
            {row.summary}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions className="shrink-0">
        <ConnectionStateLabel pending={pending} row={row} />
      </ItemActions>
    </Item>
  );
}

function ConnectionMark({
  mark,
  name,
}: {
  mark: ConnectionRow["mark"];
  name: string;
}) {
  if (mark.kind === "logo") return <PluginLogo logo={mark.logo} name={name} />;
  const Mark =
    mark.kind === "provider" ? providerIcon(mark.provider) : markFor(mark.key);
  if (!Mark) return <AppInitial name={name} />;
  return <Mark className="size-4" />;
}

/**
 * Where a tile stands, or the word for what pressing it does. An app that needs no account says
 * Connect too: the press is for using the app, and adding it is never a step of its own.
 */
const ACTION_LABEL = {
  connect: "Connect",
  add: "Connect",
  setup: "Set up",
  request: "Request",
};
const PENDING_LABEL = {
  connect: "Connecting…",
  add: "Connecting…",
  setup: "Connecting…",
  request: "Requesting…",
};

function ConnectionStateLabel({
  row,
  pending,
}: {
  row: ConnectionRow;
  pending: boolean;
}) {
  const { state } = row;
  if (state === "connected") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <IconCheck aria-hidden="true" className="size-3.5 text-success" />
        {row.noAccount ? "On" : "Connected"}
      </span>
    );
  }
  if (state === "team") {
    return (
      <span className="text-xs text-muted-foreground">Shared account</span>
    );
  }
  // Asked for, and waiting on an admin: said in words, as Shared account is, with nothing to press.
  if (row.requested) {
    return <span className="text-xs text-muted-foreground">Requested</span>;
  }
  const pill = (
    <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">
      {pending
        ? PENDING_LABEL[row.action ?? "connect"]
        : state === "needs_reconnect"
          ? "Reconnect"
          : ACTION_LABEL[row.action ?? "connect"]}
    </span>
  );
  // Added and not signed in to: said in words, beside the press that connects it.
  if (state === "available" && row.notConnected && !pending) {
    return (
      <span className="flex items-center gap-2">
        <span
          className="text-xs text-muted-foreground"
          data-testid="tile-not-connected"
        >
          Not connected
        </span>
        {pill}
      </span>
    );
  }
  return pill;
}
