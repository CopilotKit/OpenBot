import { type PluginsPage, pluginsProvider } from "./queries";

/**
 * The words an admin Plugins screen uses for the ACTIVE broker, and nothing of the other's (spec D11).
 *
 * TWO DIFFERENT QUESTIONS, AND CONFLATING THEM IS THE TRAP. A screen that FILTERS by brokered-ness
 * needs no provider name: one provider holds rows at a time (spec D3), so {@link brokeredProvenance}
 * answers it from the row. A screen that NAMES a vendor cannot derive the name from a row that
 * happens to exist — a deployment with the key set and no app enabled yet has no row at all — so it
 * reads {@link pluginsProvider} and asks this module for the words.
 *
 * Pure functions, so the vocabulary is pinned without a DOM. Nothing here carries a key or a
 * capability: the provider is a NAME.
 */
export type PluginsProvider = NonNullable<PluginsPage["provider"]>;

/** Whether a row came through a broker, whichever one. Filters; never names. */
export function brokeredProvenance(provenance: string): boolean {
  return provenance === "composio" || provenance === "arcade";
}

export type ProviderVocabulary = {
  /** The vendor's display name. */
  name: string;
  /** The directory entry's label, as the "More apps" row and the picker title say it. */
  directoryLabel: string;
  /** The environment variable an operator sets to turn the broker on. */
  envVar: string;
  /**
   * The route path of the vendor's directory screen.
   *
   * A LITERAL UNION AND NEVER `string`, because that union is TanStack Router's generated route
   * tree: a path that no route file answers stops compiling here rather than 404ing in somebody's
   * browser. That is exactly how an earlier draft named a screen that did not exist, so a `as const`
   * cast at the `<Link to=…>` call site would be casting away the only check there is.
   */
  directoryPath: "/admin/plugins/composio" | "/admin/plugins/arcade";
  /**
   * What the "More apps" row says once the key is set.
   *
   * A FIELD rather than a `provider === "composio"` branch. Composio's sentence counts its
   * directory ("a few hundred apps") and that count is Composio's, measured by nobody here; Arcade's
   * says the same thing about reach without claiming a size this deployment has not counted.
   */
  directoryDescription: string;
};

const VOCABULARY: Record<PluginsProvider, ProviderVocabulary> = {
  composio: {
    name: "Composio",
    directoryLabel: "Browse Composio",
    envVar: "COMPOSIO_API_KEY",
    directoryPath: "/admin/plugins/composio",
    directoryDescription:
      "A few hundred apps. Each person connects their own account.",
  },
  arcade: {
    name: "Arcade",
    directoryLabel: "Browse Arcade",
    envVar: "ARCADE_API_KEY",
    directoryPath: "/admin/plugins/arcade",
    directoryDescription:
      "Apps nobody here has reviewed. Each person connects their own account.",
  },
};

export function providerVocabulary(
  provider: PluginsProvider,
): ProviderVocabulary {
  return VOCABULARY[provider];
}

/**
 * What a failed directory read says when the server sent no message of its own.
 *
 * ONE SENTENCE FOR BOTH THE QUERY AND THE SCREEN, so the two layers cannot drift: the query layer's
 * fallback once spelled a vendor on its own and printed Composio's name on an Arcade deployment.
 */
export function directoryReadFailure(provider: PluginsProvider): string {
  return `Couldn't load ${VOCABULARY[provider].name}'s app directory. Reload the page.`;
}

/** The "More apps" section's own sentence. */
export function moreAppsSectionDescription(provider: PluginsProvider): string {
  return `Apps from ${VOCABULARY[provider].name}. Nobody here has reviewed them.`;
}

/**
 * The one row under "More apps".
 *
 * `linked` is whether the row goes anywhere. Both providers have a directory screen, so the row
 * links exactly when the key is configured — and the function tests the configuration and never the
 * vendor. An unconfigured row states its setting and links nowhere, because there is nowhere to go
 * until the key is set.
 */
export type MoreAppsRow = {
  title: string;
  description: string;
  linked: boolean;
};

export function moreAppsRow(
  provider: PluginsProvider,
  configured: boolean,
): MoreAppsRow {
  const { name, directoryLabel, envVar, directoryDescription } =
    VOCABULARY[provider];
  if (!configured) {
    return {
      title: name,
      description: `Not set up. Set ${envVar} on this deployment to browse its apps.`,
      linked: false,
    };
  }
  return {
    title: directoryLabel,
    description: directoryDescription,
    linked: true,
  };
}

/** The Connection card's sentence for a brokered app. */
export function brokeredConnectionDescription(
  provider: PluginsProvider,
): string {
  return `Reached through ${VOCABULARY[provider].name}, which holds each person's own account.`;
}

/** The "How this is reached" row for a brokered app: its sentence and its badge. */
export function brokeredReach(provider: PluginsProvider): {
  description: string;
  badge: string;
} {
  const { name } = VOCABULARY[provider];
  return {
    description: `${name} holds the account. This deployment sends one key and who is asking. Each person connects their own, and a Bot sees only what that person can see. There is no token to paste.`,
    badge: `Through ${name}`,
  };
}

/** What disconnecting a brokered account does, said where the button is. */
export function brokeredDisconnectNote(provider: PluginsProvider): string {
  return `Disconnecting also ends the account at ${VOCABULARY[provider].name}.`;
}

/**
 * What an admin's own brokered row says where the broker authorizes PER ACTION, in place of a
 * consent trip.
 *
 * NOT A CONSENT TRIP WITH A WORD CHANGED, because it is not the same offer. Under a per-action broker
 * there is no whole-app press to name — the row withholds Connect entirely — so this says where the
 * act actually is instead. A person reading "Connecting takes you to…" beside no Connect button is
 * being told about a button that is not there.
 *
 * The person's own page under Connections names no vendor, so it says this in its own words; the
 * admin setup page may name the broker, and reads it from here.
 *
 * `where` IS NOT DECORATION AND HAS NO DEFAULT. The two screens that draw this row do not both
 * draw the action list: the Connections page has it directly underneath, and the admin setup page
 * has none at all, so a single sentence saying "below" is a true direction on one screen and a
 * wrong one on the other — pointing somebody at a list that is not on their page is the same
 * failure as the Connect button this sentence replaces, one step further on. Each caller says
 * which it is rather than being assumed into the commoner case.
 */
export function brokeredPerActionTrip(
  provider: PluginsProvider,
  where: "below" | "settings",
): string {
  const stem = `${VOCABULARY[provider].name} approves one action at a time, so there's nothing to connect for the whole app.`;
  return where === "below"
    ? `${stem} Authorize the actions you want below.`
    : `${stem} Authorize them from Connections.`;
}

/** What a person is told where the deployment has no key for the active broker. */
export function brokeredKeyMissing(provider: PluginsProvider): string {
  return `Set ${VOCABULARY[provider].envVar} on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.`;
}

/**
 * What a Disconnect would also end, said beside the Disconnect, from the server's computed answer.
 *
 * NULL WHEN THERE IS NOTHING TO SAY. An app with no siblings gets no warning block at all, not an
 * empty one: a warning about apps that will not be touched teaches people to dismiss the one that
 * matters. `unanswered` is a COUNT and never names, because an app that could not be asked about
 * has no name this deployment could vouch for.
 *
 * It names the apps and promises nothing about confinement (D30): which other apps a consent covers
 * is the provider's property, and this sentence reports what the server counted rather than what it
 * hopes.
 */
export function disconnectSiblingsNotice(answer: {
  siblings: readonly string[];
  unanswered: number;
}): string | null {
  const { siblings, unanswered } = answer;
  const parts: string[] = [];
  if (siblings.length > 0) {
    parts.push(
      `Disconnecting also ends your access to ${joinNames(siblings)}, which ${siblings.length === 1 ? "shares" : "share"} this connection.`,
    );
  }
  if (unanswered > 0) {
    parts.push(
      siblings.length > 0
        ? `${unanswered} other ${unanswered === 1 ? "app" : "apps"} couldn't be checked and may be affected too.`
        : `${unanswered} ${unanswered === 1 ? "app" : "apps"} on this connection couldn't be checked, so disconnecting may end ${unanswered === 1 ? "it" : "them"} too.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Whether a directory route may answer on this deployment.
 *
 * `pending` until the page has said which provider this is: the default of `"composio"` is right for
 * a label and wrong for a gate, because acting on it would fire a Composio request against an Arcade
 * project in the moment before the answer arrives.
 */
export function directoryRouteDecision(
  routeProvider: PluginsProvider,
  page: PluginsPage | undefined,
): "pending" | "render" | "redirect" {
  if (!page) return "pending";
  return pluginsProvider(page) === routeProvider ? "render" : "redirect";
}
