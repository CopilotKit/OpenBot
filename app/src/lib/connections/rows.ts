import type { IdentityProviders, LinkedAccount } from "@/lib/identity/queries";
import { schemeNeedsKey } from "@/lib/plugins/enablement-notes";
import { brokeredProvenance } from "@/lib/plugins/provider-vocabulary";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";

/**
 * Every row on Connections, in one list.
 *
 * WHY ONE LIST. The page used to stack five sections — your apps, apps shared by your organisation,
 * linked accounts, GitHub events and a reset for shared Bots — and a person had to know which kind
 * of thing they were looking for before they could find it. From where they stand each of these is
 * the same thing: a service, connected or not. So each is a row, and what is particular to one —
 * GitHub's repositories, Slack's link code, a key app's fields — is on that row's own page.
 */
export type ConnectionState =
  /** The person's own account is connected. */
  | "connected"
  /** It was connected and the provider no longer accepts it. */
  | "needs_reconnect"
  /** The organisation's account: nothing for the person to connect. */
  | "team"
  /** Not connected yet. */
  | "available";

export type ConnectionRow = {
  /** Where the row's page is: `/connections/$key`. */
  key: string;
  title: string;
  summary: string;
  state: ConnectionState;
  /**
   * What pressing a tile that is not in use does, in the personal edition, where every app is a
   * tile. `connect` adds the app if needed and signs in to your account, `add` turns on an app with
   * no account, and `setup` opens the app's page because something has to be typed there first.
   * Absent everywhere else: the tile opens its page.
   */
  action?: "connect" | "add" | "setup";
  /** An app with no account behind it, which reads "On" rather than "Connected" once added. */
  noAccount?: boolean;
  /**
   * Added, and the person's own account isn't connected yet. The tile says "Not connected" beside
   * Connect, so an app that is on never reads as ready before anybody has signed in to it.
   */
  notConnected?: boolean;
  /** What draws the row's mark: a catalogue icon, an app's logo, or an identity provider's icon. */
  mark:
    | { kind: "catalogue"; key: string }
    | { kind: "logo"; logo: string | null | undefined }
    | { kind: "provider"; provider: "github" | "slack" };
};

/**
 * Whether a server is a broker's GitHub app, whichever broker enabled it: the app GitHub's own page
 * links to instead of listing it twice.
 *
 * A brokered row's id is its broker's prefix and the app's slug, and the prefix is the provenance it
 * was minted under (`composio-github`, `arcade-github`), so this asks the row and names no vendor.
 */
export function isBrokeredGithub(
  server: Pick<PluginServer, "id" | "provenance">,
): boolean {
  return (
    brokeredProvenance(server.provenance) &&
    server.id === `${server.provenance}-github`
  );
}

export const IDENTITY_SUMMARIES = {
  github:
    "Lets OpenBot recognise you on GitHub, so a repository's events can start your Bots' work.",
  slack: "Lets OpenBot recognise you when you message it from Slack.",
} as const;

/**
 * The same, short enough for a Connections tile, where the line is one line wide and the full
 * sentence was cut off mid-word. The full one stays on each connection's own page.
 */
const IDENTITY_TILE_SUMMARIES = {
  github: "Repository events can start Bots.",
  slack: "Message OpenBot from Slack.",
} as const;

const IDENTITY_TITLES = { github: "GitHub", slack: "Slack" } as const;

export function connectionRows(input: {
  /** Catalogue apps a person connects for themselves, already narrowed to the enabled ones. */
  catalogue: CatalogueItem[];
  /** Brokered apps a person connects for themselves. */
  brokered: PluginServer[];
  /** Brokered apps that run on the organisation's account. */
  shared: PluginServer[];
  /** Server ids the person holds a connection for. */
  connected: ReadonlySet<string>;
  links: LinkedAccount[];
  providers: IdentityProviders | undefined;
}): ConnectionRow[] {
  const identity = (["github", "slack"] as const).flatMap(
    (provider): ConnectionRow[] => {
      const link = input.links.find((entry) => entry.provider === provider);
      if (!link && !input.providers?.[provider]) return [];
      return [
        {
          key: provider,
          title: IDENTITY_TITLES[provider],
          summary: link?.handle
            ? `@${link.handle}`
            : IDENTITY_TILE_SUMMARIES[provider],
          state: !link
            ? "available"
            : link.status === "needs_reconnect"
              ? "needs_reconnect"
              : "connected",
          mark: { kind: "provider", provider },
        },
      ];
    },
  );
  /*
   * ONE GITHUB ROW. With the GitHub link on offer, a brokered GitHub app would be a second row of the
   * same name; GitHub's page links to it instead, so the list names the vendor once.
   */
  const githubListed = identity.some((row) => row.key === "github");
  /*
   * AND THAT ONE ROW SPEAKS FOR THE TOOLS TOO. The GitHub link only recognises a person; a Bot uses
   * GitHub through the added app, which is connected separately. With the app added and not
   * connected, the tile says "Not connected" beside Connect, as the Bot does, never "Connected" off
   * the link alone.
   */
  const githubTools = input.brokered.find(isBrokeredGithub);
  if (githubListed && githubTools && !input.connected.has(githubTools.id)) {
    const github = identity.find((row) => row.key === "github");
    if (github && github.state !== "needs_reconnect") {
      github.state = "available";
      github.notConnected = true;
    }
  }
  const rows: ConnectionRow[] = [
    ...input.catalogue.map(
      (entry): ConnectionRow => ({
        key: entry.key,
        title: entry.title,
        summary: entry.summary,
        state: input.connected.has(entry.key) ? "connected" : "available",
        notConnected: !input.connected.has(entry.key),
        mark: { kind: "catalogue", key: entry.key },
      }),
    ),
    ...input.brokered
      .filter((server) => !(githubListed && isBrokeredGithub(server)))
      .map(
        (server): ConnectionRow => ({
          key: server.id,
          title: server.title,
          // No line rather than "Connect your Todoist account.", which only repeated the tile's
          // Connect button. A key app not yet connected says it needs a key, so nobody who
          // expected a sign-in is surprised when the page asks for one.
          summary:
            !input.connected.has(server.id) && schemeNeedsKey(server.authScheme)
              ? `Needs a key from ${server.title}`
              : server.summary,
          state: input.connected.has(server.id) ? "connected" : "available",
          notConnected: !input.connected.has(server.id),
          mark: { kind: "logo", logo: server.logo },
        }),
      ),
    ...input.shared.map(
      (server): ConnectionRow => ({
        key: server.id,
        title: server.title,
        summary: "Your organisation's account. Bots act as the team here.",
        state: "team",
        mark: { kind: "logo", logo: server.logo },
      }),
    ),
    ...identity,
  ];
  /*
   * What is already in use first, so the list opens on what a person has rather than on everything
   * they could add. Stable within each half: the order above, which keeps apps before accounts.
   */
  const inUse = (row: ConnectionRow) => row.state !== "available";
  return [...rows.filter(inUse), ...rows.filter((row) => !inUse(row))];
}

/**
 * The app every edition turns on for every Bot at startup and never turns off. The server
 * names the same one in `server/src/plugins/personal-defaults.ts`.
 */
export const ALWAYS_ON_APP = "routines";

/**
 * The personal edition's tiles: every app in the catalogue, whether or not it has been added, and
 * the same brokered apps and GitHub link as {@link connectionRows}.
 *
 * One person adds an app and connects their account, so the two are one press: a tile says what
 * that press does. An app reached as you is Connect. An app with no account at all (a free search
 * provider, Routines) is Add, and On once added. An app that needs a key typed first is Set up,
 * and is On once added with it.
 *
 * ONE PRESS OR NOT AT ALL, UNLESS ASKED. An app that needs a key or an OAuth client typed before it
 * connects is where a person gets stuck, so it is left out unless `everything` is set or it is
 * already in use. Slack is left out too: the personal edition has no Slack.
 */
export function personalConnectionRows(input: {
  /** Also the apps that need something typed before they connect. */
  everything?: boolean;
  catalogue: CatalogueItem[];
  added: ReadonlySet<string>;
  brokered: PluginServer[];
  connected: ReadonlySet<string>;
  links: LinkedAccount[];
  providers: IdentityProviders | undefined;
}): ConnectionRow[] {
  const apps = input.catalogue.flatMap((entry): ConnectionRow[] => {
    const row = personalAppRow(entry, input);
    return input.everything || entry.oneStep || row.state !== "available"
      ? [row]
      : [];
  });
  const rest = connectionRows({
    catalogue: [],
    brokered: input.brokered,
    shared: [],
    connected: input.connected,
    links: input.links,
    providers: input.providers,
  }).filter((row) => row.key !== "slack");
  const rows = [...apps, ...rest];
  const inUse = (row: ConnectionRow) => row.state !== "available";
  return [...rows.filter(inUse), ...rows.filter((row) => !inUse(row))];
}

/** How many apps the personal Connections leaves out until asked: see {@link personalConnectionRows}. */
export function personalAppsNeedingSetup(input: {
  catalogue: CatalogueItem[];
  added: ReadonlySet<string>;
  connected: ReadonlySet<string>;
}): number {
  return input.catalogue.filter(
    (entry) =>
      !entry.oneStep && personalAppRow(entry, input).state === "available",
  ).length;
}

function personalAppRow(
  entry: CatalogueItem,
  input: { added: ReadonlySet<string>; connected: ReadonlySet<string> },
): ConnectionRow {
  const base = {
    key: entry.key,
    title: entry.title,
    summary: entry.summary,
    mark: { kind: "catalogue", key: entry.key } as const,
  };
  if (entry.auth === "user-oauth")
    return {
      ...base,
      state: input.connected.has(entry.key) ? "connected" : "available",
      action: "connect",
      notConnected:
        input.added.has(entry.key) && !input.connected.has(entry.key),
    };
  return {
    ...base,
    state: input.added.has(entry.key) ? "connected" : "available",
    action: entry.auth === "deployment-bearer" ? "setup" : "add",
    noAccount: true,
  };
}
