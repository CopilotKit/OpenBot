import {
  IconAppsOff,
  IconArrowUpRight,
  IconChevronDown,
  IconPlugOff,
  IconUsers,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { IdentityConnectionPage } from "@/components/connections/identity-connection-page";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  BrokeredAccountRow,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { GrantList } from "@/components/plugins/grant-list";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  brokeredProvenance,
  disconnectSiblingsNotice,
} from "@/lib/plugins/provider-vocabulary";
import {
  connectionSiblingsQueryOptions,
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
  pluginsProvider,
} from "@/lib/plugins/queries";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Whether this server is reached through Composio AS THIS PERSON.
 *
 * A Shared app is also `provenance === "composio"` — it is still Composio that holds the account —
 * but there is no "your account" here to confirm: the one account is the deployment's, and every
 * Bot holding a grant acts as it regardless of who is asking. Exported so the test for this file can
 * pin the distinction without rendering the page.
 */
export function brokeredFor(server: PluginServer | undefined): boolean {
  /*
   * A FILTER, so it asks whether the row came through a broker at all and needs no vendor name: one
   * provider holds rows at a time (spec D3). Naming the vendor on this page is a different question
   * and reads the active provider, below.
   */
  return (
    server !== undefined &&
    brokeredProvenance(server.provenance) &&
    server.accountMode !== "shared"
  );
}

/** The longest action name this page will repeat back. Real ones are far shorter. */
const MAX_LANDED_ACTION = 200;

/**
 * The action the verifier's redirect says was just authorized, or null.
 *
 * A TRIMMED, BOUNDED NAME AND NOTHING ELSE: it is read off a query string, which anybody can write
 * on this origin, so it is only ever drawn as a quoted name inside this page's own sentence and
 * never as a sentence of its own.
 */
export function landedActionFrom(action: string | undefined): string | null {
  const trimmed = (action ?? "").trim();
  return trimmed.length > 0 && trimmed.length <= MAX_LANDED_ACTION
    ? trimmed
    : null;
}

/** What the landing says about the action somebody has just come back from authorizing. */
export function landedActionNotice(action: string): string {
  return `You just authorized ${action}.`;
}

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute("/_authed/_app/connections/$key")({
  component: RouteComponent,
  /*
   * `?linked=` is how the GitHub account-link callback reports back to GitHub's page: `github` on
   * success, `github-taken` when that account belongs to another OpenBot user, `failed` otherwise.
   *
   * `?action=` is the verifier's redirect saying WHICH action the consent just completed was for,
   * so an app's page can land on it rather than on the app.
   *
   * Each key is omitted when absent rather than set to undefined, which would make `search` a
   * required prop on every Link to this route. Read as text whatever the router parsed it into
   * (`searchText`): an action name made of digits or shaped like JSON arrives as a number or an
   * object, and a `typeof` guard would land the page on the app as though the verifier had never
   * said which action it was.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { linked?: string; action?: string } => ({
    ...searchTextEntry("linked", search.linked),
    ...searchTextEntry("action", search.action),
  }),
});

/**
 * GitHub and Slack are accounts this deployment links to a person, not apps an administrator
 * enabled, so they have a page of their own; every other key is an app.
 */
function RouteComponent() {
  const { key } = Route.useParams();
  const { linked } = Route.useSearch();
  if (key === "github" || key === "slack") {
    return <IdentityConnectionPage linked={linked} provider={key} />;
  }
  return <AppConnectionPage />;
}

function AppConnectionPage() {
  const { key } = useParams({
    from: "/_authed/_app/connections/$key",
  });
  const { action } = Route.useSearch();
  /*
   * `?action=` IS READ ONCE HERE AND DROPPED FROM THE URL BELOW, BUT IT FEEDS TWO THINGS.
   *
   * Its only sender is the per-action verifier's redirect (`server/src/plugins/routes.ts`), so it is
   * a report of a consent that has just completed — news exactly once. Left in the address bar it is
   * read again on every reload and back-navigation, and "You just authorized X" is redrawn about a
   * consent that may be hours old. That is the omission the Connections list closed for its own
   * three report parameters.
   *
   * It is NOT only the notice, though: the same value marks the matching row of the grant list with
   * `data-landed`, and that list draws only once its own read answers — which can be well after the
   * strip has landed. So the strip is safe only because BOTH readers draw from this snapshot, never
   * from the live search: read live, the notice would vanish with the parameter and the grant list
   * would come up with nothing marked. The mark is the same news as the notice, so it is right for
   * both to outlive the URL for this visit and for both to be gone on a reload.
   *
   * KEYED ON THE APP, so a snapshot taken on one app's page is never repeated on another's should the
   * router keep this component mounted across a change of `$key`.
   */
  const [arrival] = useState(() => ({
    key,
    landedAction: landedActionFrom(action),
  }));
  const navigate = Route.useNavigate();
  /*
   * ONE NAVIGATE, the same shape as the Connections list's: `search` replaces the whole object, so
   * a strip is written as dropping its keys from what is there and keeping the rest, never as a
   * rebuilt object. `linked` belongs to GitHub's page, which is not this one, so `action` is the
   * only one dropped.
   */
  useEffect(() => {
    if (action === undefined) return;
    navigate({ search: ({ action: _a, ...rest }) => rest, replace: true });
  }, [action, navigate]);
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (start) => {
      /*
       * A 200 with no url on it is not a url to follow. Every press that reaches here is on a
       * `user-oauth` catalogue entry, whose half of that route always mints one or refuses — so
       * this is the server having answered something this page does not understand, and saying so
       * is the only honest thing left. Assigning it navigated to a page called `undefined` on this
       * deployment's own origin. See `connectAccountMutationOptions`.
       *
       * `{ connected: true }` is a brokered app's answer and never this half's, so it is the same
       * not-understood answer here.
       */
      const authorizationUrl =
        start !== null && "authorizationUrl" in start
          ? start.authorizationUrl
          : null;
      if (authorizationUrl === null) {
        setNotice(
          "Couldn't start connecting, so nothing was connected. Try again, or ask an admin if it keeps happening.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = (plugins.data?.servers ?? []).find((s) => s.id === key);
  const enabled = server !== undefined;
  /*
   * READ THROUGH `personalConnections`, never the raw list: a Shared app's row is the deployment's
   * one standing account, not this person's, and `find` over the unfiltered rows would have handed
   * it to this page as if it were.
   */
  const connection = personalConnections(
    connections.data?.connections ?? [],
  ).find((row) => row.serverId === key);
  /*
   * Asked of the row rather than the catalogue, because a brokered app has no catalogue entry at
   * all: the deployment recorded how it is reached when the app was enabled, and that record is the
   * only thing here that knows.
   */
  const brokered = brokeredFor(server);
  /*
   * THE VENDOR'S NAME, from the active provider and never from a row: a deployment with the key set
   * and nothing enabled has no row, and a row cannot say which broker holds the account.
   */
  const provider = pluginsProvider(plugins.data);
  /*
   * WHAT A DISCONNECT WOULD ALSO END, asked only while there is an account for it to end. The query
   * is gated on the connection and its answer is read only through the same gate, so a cached answer
   * from before a disconnect is never drawn beside "Connect".
   */
  const siblings = useQuery({
    ...connectionSiblingsQueryOptions(key),
    enabled: brokered && connection !== undefined,
  });
  const siblingsNotice =
    brokered && connection !== undefined && siblings.data
      ? disconnectSiblingsNotice(siblings.data)
      : null;
  /* From the snapshot above and never from the live search, which is stripped. */
  const landedAction = arrival.key === key ? arrival.landedAction : null;
  /*
   * THE GRANT LIST IS DRAWN WHERE THE BROKER AUTHORIZES PER ACTION, read off the declared
   * capability and never off the vendor's name. The server computes `authorizesPerAction` from the
   * same expression `/servers/:id/authorize` behind the Authorize button gates on, so the list this
   * screen draws and the route its buttons call cannot key on different facts. `provider ===
   * "arcade"` keyed on a different one: the day a broker named arcade is reached with that flow
   * absent, this drew the list and every press 503'd. False on Composio — whose auth config fixes
   * one state for the whole toolkit — so every Composio render is unchanged.
   */
  const perActionGrants = plugins.data?.authorizesPerAction ?? false;
  /* Who is asking only matters to a Shared app's Authorize, so it is not read for anything else. */
  const sharedHere = server?.accountMode === "shared";
  const me = useQuery({
    ...currentUserQueryOptions(),
    enabled: perActionGrants && sharedHere,
  }).data;
  const isAdmin = me?.role === "admin";
  const appNames = [key, server?.title ?? key];

  /* Everything the brokered row below reads and does. See `brokered-account-row.tsx`. */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    /* The same capability the grant list below is drawn on, read once above and passed to both, so
       the row's offer and the list's presence cannot come from different facts. */
    authorizesPerAction: perActionGrants,
    brokered,
    configured: plugins.data?.composioConfigured ?? false,
    recorded: connection !== undefined,
    report: setNotice,
    returnTo: "settings",
    serverId: key,
    /*
     * Off the same row `recorded` is read from, and absent where you have never connected this app:
     * with no row there is nothing that could have been checked, which is what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    /*
     * PASSED THROUGH UNFLATTENED, unlike the two above. Their fallbacks are the server's own column
     * defaults, so an absent field and a recorded one mean the same thing; this one's null is the
     * server saying the last check of this key spent nothing, which is a different fact from having
     * been told nothing. Collapsing the two would hand the row a verdict on every page load that
     * has no record behind it.
     */
    probe: connection?.probe,
    /*
     * AND THIS ONE IS FLATTENED AGAIN, because it is a gate and not a verdict. `probe` is the
     * record of what the last check spent and this is whether the app has anything to check with
     * today — two questions, which is why they are two fields: gating the Re-check button on the
     * record left a key nothing was ever spent on unable to ever have anything spent on it. A
     * missing gate and a closed gate are the same gate, so absent collapses to false here where a
     * missing verdict above may not collapse to a null one.
     */
    checkable: connection?.checkable ?? false,
  });

  /*
   * BOTH READS ARE WAITED FOR, BECAUSE EVERY FACT THE BROKERED ROW BELOW DRAWS COMES FROM THE SECOND
   * ONE. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable` are all off `connection`,
   * and this gated on `plugins` alone — so a connections read still in flight drew the row with the
   * whole of its state defaulted to "you have never connected this".
   */
  if (plugins.isPending || connections.isPending) {
    return <PageShell title="Account">{null}</PageShell>;
  }

  const back = {
    label: "Connections",
    linkProps: { to: "/connections" as const },
  };

  /*
   * AND A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, WHICH IS WHAT THIS PAGE DID
   * WITH IT.
   *
   * Nothing read `connections.error`, so a 500 from `/api/plugins/connections` left `connection`
   * undefined and the row was handed `recorded: false, verified: false, probe: undefined,
   * checkable: false` — a connection nobody has made. For a brokered key app whose last check did
   * not come back clean, that is the exact state this whole feature exists to keep visible: the page
   * dropped the sentence, hid Disconnect AND Re-check, and drew Connect instead. Pressing it opens
   * the form and the route refuses the submission — "you already have an account, disconnect it
   * first" — so the only two controls that could end the state are the two the page just withdrew,
   * and no error text appears anywhere, because `connect.onError` is this route's only error branch.
   *
   * SAID BEFORE THE ROW RATHER THAN INSTEAD OF IT, and the row is not drawn at all: a row whose
   * entire content is connection state has nothing honest to say when that state could not be read.
   */
  if (connections.error) {
    return (
      <PageShell backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load this connection. Reload the page, or ask an admin if it
          keeps happening.
        </p>
      </PageShell>
    );
  }

  /*
   * The same for the plugin list. Every branch below decides what this connector is from it, and
   * without it they concluded there is none: "This is not a service you connect for yourself",
   * about a connector this person may hold right now.
   */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Couldn't load this app. Reload the page, or ask an admin if it keeps
          happening.
        </p>
      </PageShell>
    );
  }

  /*
   * A COMPOSIO APP ON A DEPLOYMENT WITH NO COMPOSIO KEY, BEFORE EITHER BRANCH BELOW DRAWS A ROW.
   *
   * The list on the way in no longer offers one, but a link from elsewhere still lands here, and the
   * brokered row's own sentence for this case names an environment variable — an instruction for
   * whoever runs the deployment, read by somebody who cannot act on it.
   */
  if (server?.provenance === "composio" && !plugins.data.composioConfigured) {
    return (
      <PageShell backButton={back} title={server.title}>
        <PageEmpty icon={IconPlugOff} title="Not set up yet">
          An admin has to turn on {server.title} before anyone can connect it.
        </PageEmpty>
      </PageShell>
    );
  }

  /*
   * A SHARED APP, BEFORE THE BROKERED BRANCH BELOW GETS A LOOK AT IT.
   *
   * `brokered` above already reads false for one of these — `brokeredFor` is what pulls a Shared
   * app out of that branch — so without one of its own here it would fall all the way to the
   * `user-oauth` branch and draw "Your account" with a Connect button over an account that is not
   * this person's to connect, confirm or disconnect. There is nothing to decide: the account is the
   * deployment's, every Bot holding a grant already acts as it, and this page says so and stops.
   */
  if (server?.accountMode === "shared") {
    return (
      <PageShell backButton={back} title={server.title}>
        {/*
         * THE LANDING NOTICE BELONGS HERE TOO, because a Shared app's account is the deployment's
         * and the verifier lands BOTH holders on this page. Without it the one flow whose Authorize
         * is admin-only completed a consent at the vendor and came back to a screen that named
         * nothing — the grant list's mark alone, several rows down a search box, is not the page
         * saying what just happened.
         */}
        {landedAction ? (
          <p
            className="text-sm"
            data-landed-action={landedAction}
            role="status"
          >
            {landedActionNotice(landedAction)}
          </p>
        ) : null}

        {/* One fact, so no heading and no actions: there is nothing here for this person to do. */}
        <PageSection>
          <PageRows className="mt-0">
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Team account</ItemTitle>
                <ItemDescription>
                  Shared by your organisation. Bots act as the team account.
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        </PageSection>

        {/* State is shown to everyone; minting a consent is the administrator's act. */}
        {perActionGrants ? (
          <GrantList
            appNames={appNames}
            canAuthorize={isAdmin}
            landedAction={landedAction}
            returnTo="settings"
            serverId={key}
          />
        ) : null}
      </PageShell>
    );
  }

  /*
   * A brokered app, before the catalogue is consulted at all.
   *
   * It has no catalogue entry, so the branch below would find no `entry`, decide the deployment has
   * no connector by that name, and say so under the raw id — about the one connector the list on the
   * way in demonstrably drew a row for. Falling through to the `user-oauth` branch instead is no
   * better: its title and summary are the catalogue's, and there is none.
   */
  if (brokered && server) {
    /* Bound once because the row below is told it twice — once inside the whole disconnected
       sentence and once on its own — and two copies of it would drift. */
    const reassurance = "No Bot can use this as you.";
    /* Where the next step is. A broker that approves one action at a time has no whole-app Connect,
       so the sentence points at the action list underneath instead of a button that is not there. */
    const trip = perActionGrants
      ? "Authorize the actions you want below."
      : `Connecting takes you to ${server.title} to approve access.`;

    return (
      <PageShell
        backButton={back}
        description="Bots use this as you, and see only what you can see."
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {landedAction ? (
          <p
            className="text-sm"
            data-landed-action={landedAction}
            role="status"
          >
            {landedActionNotice(landedAction)}
          </p>
        ) : null}

        {/* One decision, so no heading: it would only repeat the row's own title. */}
        <PageSection>
          <PageRows className="mt-0">
            <BrokeredAccountRow
              account={brokeredAccount}
              /* Said beside the button rather than after it: disconnecting ends the account at
                 Composio, so what it undoes is not the row here but the grant on your own mailbox,
                 and connecting again is a fresh consent. */
              connectedDescription={`Bots you allow use your ${server.title} as you. Disconnecting removes their access everywhere.`}
              disconnectedDescription={`${reassurance} ${trip}`}
              /* What is true either way. The trip to Composio is not — an app whose key somebody
                 types never leaves this page — but which Bots can read this person's mail is the
                 whole point of the screen and holds for both kinds. */
              disconnectedReassurance={reassurance}
              notice={siblingsNotice ?? undefined}
              provider={provider}
              title={server.title}
            />
          </PageRows>
        </PageSection>

        {perActionGrants ? (
          <GrantList
            appNames={appNames}
            canAuthorize
            landedAction={landedAction}
            returnTo="settings"
            serverId={key}
          />
        ) : null}
      </PageShell>
    );
  }

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="You don't connect this app yourself."
        title={entry?.title ?? key}
      >
        <PageEmpty
          icon={entry ? IconUsers : IconAppsOff}
          title={entry ? "Shared account" : "App not found"}
        >
          {entry
            ? "Bots use one shared account for this app, the same for everybody."
            : "OpenBot has no app by that name."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Connect your account": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>Your account</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "Not available yet. An admin has to turn this on first."
                  : connection
                    ? "Bots you allow use this as you, and see only what you can see."
                    : `No Bot can use this as you. Connecting takes you to ${entry.vendor} to approve access.`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        Connected
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() =>
                        /*
                         * NOT BUILT YET, and it says so rather than appearing to work.
                         *
                         * Withdrawing is three acts — revoke at the vendor, revoke the vault
                         * credential, delete the row — and none exist. An item that closed the menu
                         * and changed nothing would report that access had been withdrawn when it
                         * had not, which is the one outcome worse than not offering it.
                         */
                        setNotice(
                          `You can't disconnect here yet. To stop access now, remove OpenBot in your ${entry.vendor} account's third-party access settings.`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      Disconnect your {entry.title} account
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                /*
                 * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                 * vendor's own consent page, and a control that navigates away should look like one.
                 */
                <Button
                  disabled={!enabled || connect.isPending}
                  onClick={() => {
                    setNotice(null);
                    connect.mutate(key);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Connect
                  <IconArrowUpRight />
                </Button>
              )}
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description={`Review the permissions recorded by ${entry.vendor}. They may include fewer permissions than OpenBot requested.`}
          title="Access"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Allowed</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || `${entry.vendor} didn't say.`}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Connected</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
