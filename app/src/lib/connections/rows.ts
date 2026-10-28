import type { IdentityProviders, LinkedAccount } from "@/lib/identity/queries";
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
            : IDENTITY_SUMMARIES[provider],
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
  const rows: ConnectionRow[] = [
    ...input.catalogue.map(
      (entry): ConnectionRow => ({
        key: entry.key,
        title: entry.title,
        summary: entry.summary,
        state: input.connected.has(entry.key) ? "connected" : "available",
        mark: { kind: "catalogue", key: entry.key },
      }),
    ),
    ...input.brokered
      .filter((server) => !(githubListed && isBrokeredGithub(server)))
      .map(
        (server): ConnectionRow => ({
          key: server.id,
          title: server.title,
          summary: server.summary || `Connect your ${server.title} account.`,
          state: input.connected.has(server.id) ? "connected" : "available",
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
