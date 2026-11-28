import { directorySlug } from "@/lib/apps/queries";
import { vendorNameOf } from "@/lib/apps/vendor-name";
import type { IdentityProviders, LinkedAccount } from "@/lib/identity/queries";
import { appNeedsKey } from "@/lib/plugins/enablement-notes";
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
  action?: "connect" | "add" | "setup" | "request";
  /** An app with no account behind it, which reads "On" rather than "Connected" once added. */
  noAccount?: boolean;
  /** A member asked an admin to add this app and the request is still waiting. */
  requested?: boolean;
  /** The directory entry a tile from the directory stands for: its press adds or asks for it. */
  directoryEntryId?: string;
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
 * Whether an app is the directory's GitHub app, whichever service the directory comes from: the app
 * GitHub's own page links to instead of listing it twice. Asked of the directory entry the app was
 * added from, so it names no service.
 */
export function isBrokeredGithub(
  server: Pick<PluginServer, "directoryEntryId">,
): boolean {
  return directorySlug(server.directoryEntryId) === "github";
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
  /** MCP servers somebody added by their address. Absent reads as none. */
  byUrl?: PluginServer[];
  /** Server ids the person holds a connection for. */
  connected: ReadonlySet<string>;
  /** Of those, the ones that need reconnecting (`needsReconnecting`). Absent reads as none. */
  reconnect?: ReadonlySet<string>;
  links: LinkedAccount[];
  providers: IdentityProviders | undefined;
}): ConnectionRow[] {
  const state = connectionState(input);
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
        state: state(entry.key),
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
            !input.connected.has(server.id) && appNeedsKey(server)
              ? `Needs a key from ${vendorNameOf(server.title)}`
              : server.summary,
          state: state(server.id),
          notConnected: !input.connected.has(server.id),
          mark: { kind: "logo", logo: server.logo },
        }),
      ),
    ...input.shared.map(
      (server): ConnectionRow => ({
        key: server.id,
        title: server.title,
        summary: "Your organization's shared account. Bots act as it here.",
        state: "team",
        mark: { kind: "logo", logo: server.logo },
      }),
    ),
    ...(input.byUrl ?? []).map((server) => byUrlRow(server, state)),
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
 * Whether one of the person's own connections needs reconnecting: a sign-in whose grant the vendor
 * withdrew (`revoked`), or a key the app didn't take (a check that ran and came back with a failure).
 * The tile says Reconnect for it, as a Bot's Apps row does, and never Connected.
 */
export function needsReconnecting(connection: {
  revoked?: boolean;
  verified?: boolean;
  probe?: string | null;
}): boolean {
  return (
    connection.revoked === true ||
    (Boolean(connection.probe) && connection.verified === false)
  );
}

/** Where one of the person's apps stands: connected, to reconnect, or not connected yet. */
function connectionState(input: {
  connected: ReadonlySet<string>;
  reconnect?: ReadonlySet<string>;
}): (id: string) => ConnectionState {
  return (id) =>
    !input.connected.has(id)
      ? "available"
      : input.reconnect?.has(id)
        ? "needs_reconnect"
        : "connected";
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
 * provider) is Add, and On once added. An app that needs a key typed first is Set up, and is On
 * once added with it.
 *
 * Routines is left out: it is on for every Bot and has its own page in the main menu, so there is
 * nothing to add or connect. Slack is left out too: the personal edition has no Slack.
 */
export function personalConnectionRows(input: {
  catalogue: CatalogueItem[];
  added: ReadonlySet<string>;
  brokered: PluginServer[];
  byUrl?: PluginServer[];
  connected: ReadonlySet<string>;
  reconnect?: ReadonlySet<string>;
  links: LinkedAccount[];
  providers: IdentityProviders | undefined;
}): ConnectionRow[] {
  const apps = input.catalogue
    .filter((entry) => entry.key !== ALWAYS_ON_APP)
    .map((entry) => personalAppRow(entry, input));
  const rest = connectionRows({
    catalogue: [],
    brokered: input.brokered,
    shared: [],
    byUrl: input.byUrl,
    connected: input.connected,
    reconnect: input.reconnect,
    links: input.links,
    providers: input.providers,
  }).filter((row) => row.key !== "slack");
  const rows = [...apps, ...rest];
  const inUse = (row: ConnectionRow) => row.state !== "available";
  return [...rows.filter(inUse), ...rows.filter((row) => !inUse(row))];
}

/**
 * The team edition's catalogue tiles for apps nobody here has added yet, where apps are open and so
 * anybody adds one: only the ones that connect in one press (`oneStep`), because one that needs a
 * host, a client or a key typed first is set up by an admin before anybody can add it. Each press
 * adds the app and connects the person's own account, as the personal edition's tiles do.
 */
export function catalogueToAddRows(input: {
  catalogue: CatalogueItem[];
  added: ReadonlySet<string>;
  connected: ReadonlySet<string>;
}): ConnectionRow[] {
  return input.catalogue
    .filter(
      (entry) =>
        entry.key !== ALWAYS_ON_APP &&
        !input.added.has(entry.key) &&
        entry.oneStep &&
        !entry.perInstance &&
        (entry.auth === "user-oauth" || entry.auth === "none"),
    )
    .map((entry) => personalAppRow(entry, input));
}

function personalAppRow(
  entry: CatalogueItem,
  input: {
    added: ReadonlySet<string>;
    connected: ReadonlySet<string>;
    reconnect?: ReadonlySet<string>;
  },
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
      state: connectionState(input)(entry.key),
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

/**
 * Apps from the directory that nobody here has added, as tiles under Add an app, for a search on
 * Connections that reaches past the apps already here.
 *
 * Only ones not added: an added app is already one of the person's own rows. Only ones whose name
 * isn't already a row, so an app added from the catalogue never shows twice. The press is the
 * person's: `connect` adds the app and connects their account in one go (anybody who may add apps),
 * `add` turns on an app with no account, and `request` asks an admin to add it (a member).
 */
export function directoryRows(input: {
  entries: readonly {
    id: string;
    title: string;
    summary: string;
    logo: string | null;
    appId: string | null;
    connectsWith: string;
  }[];
  /** Whether this person adds apps themselves, or asks an admin to. */
  mayAdd: boolean;
  /** The titles already on the page, lower case. */
  listed: ReadonlySet<string>;
  /** Slugs this person has asked an admin for, still waiting. */
  requested: ReadonlySet<string>;
}): ConnectionRow[] {
  return input.entries
    .filter(
      (entry) =>
        entry.appId === null &&
        !input.listed.has(entry.title.toLocaleLowerCase()),
    )
    .map((entry): ConnectionRow => {
      const slug = directorySlug(entry.id) ?? entry.id;
      return {
        key: slug,
        directoryEntryId: entry.id,
        title: entry.title,
        summary:
          entry.connectsWith === "key"
            ? `Needs a key from ${entry.title}`
            : entry.summary,
        state: "available",
        action: !input.mayAdd
          ? "request"
          : entry.connectsWith === "nothing"
            ? "add"
            : "connect",
        requested: !input.mayAdd && input.requested.has(slug),
        mark: { kind: "logo", logo: entry.logo },
      };
    });
}

/**
 * A server somebody added by its address. Its line is where it lives, which is how a person tells two
 * servers apart when nobody gave them a logo. One that signs each person in reads like any app you
 * connect: Connect until you have, then Connected. One that needs no account is On.
 */
function byUrlRow(
  server: PluginServer,
  state: (id: string) => ConnectionState,
): ConnectionRow {
  const host = hostOf(server.address ?? "");
  const base = {
    key: server.id,
    title: server.title,
    mark: { kind: "logo", logo: server.logo } as const,
  };
  if (server.signIn) {
    const yours = state(server.id) !== "available";
    return {
      ...base,
      summary: host,
      state: state(server.id),
      /*
       * No press-to-connect here, unlike a catalogue app: the tile opens the server's own page,
       * which offers Connect beside the switch that takes the server away again. A server added by
       * its address has no other way back to that switch.
       */
      notConnected: !yours,
    };
  }
  return { ...base, summary: host, state: "connected", noAccount: true };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
