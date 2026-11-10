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

/**
 * Which edition reads the sentence. The team edition's words are for an admin and for each person
 * in a team; the personal edition has one person, on their own computer, and is spoken to as "you".
 * `managePaths(...).edition` carries it, read from the deployment's capabilities.
 */
export type Edition = "team" | "personal";

/**
 * What this person actually does to connect: click through a consent screen, type a secret, or
 * nothing at all. See `kindOf` in `brokered-account-row.tsx`, which reads it off the app's scheme.
 */
export type BrokeredAccountKind = "consent" | "fields" | "no-auth";

/** The app a personal sentence names, and how it is connected. */
export type BrokeredApp = { title: string; kind: BrokeredAccountKind };

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a row came through a broker, whichever one. Filters; never names. */
export function brokeredProvenance(provenance: string): boolean {
  return provenance === "composio" || provenance === "arcade";
}

/*
 * NO VENDOR NAME IN ANY OF IT. A person connects their work apps through OpenBot, and the broker
 * behind it (Composio or Arcade) is never named on a screen, the admin's included. The one vendor
 * word left is the environment variable an admin sets, because that name is the whole remedy.
 */
export type ProviderVocabulary = {
  /** The directory entry's label, as the "More apps" row and the picker title say it. */
  directoryLabel: string;
  /** The environment variable an operator sets to turn the broker on. */
  envVar: string;
  /*
   * No route path here. Where the directory screen lives depends on the edition (under Admin, or
   * under Settings), so `managePaths(...).brokerDirectory(provider)` names it, from the same
   * generated route tree: a path no route file answers still stops compiling.
   */
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
    directoryLabel: "Browse apps",
    envVar: "COMPOSIO_API_KEY",
    directoryDescription:
      "A few hundred apps. Each person connects their own account.",
  },
  arcade: {
    directoryLabel: "Browse apps",
    envVar: "ARCADE_API_KEY",
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
export function directoryReadFailure(_provider: PluginsProvider): string {
  return "Couldn't load the apps you can connect. Reload the page.";
}

/**
 * The directory screen's own two sentences: its description and its search section's.
 *
 * Adding an app there connects nobody, in either edition. In the team edition each person connects
 * their own account afterwards; in the personal one, the one person does, on the app's page.
 */
export function directoryDescriptions(edition: Edition = "team"): {
  page: string;
  search: string;
} {
  return edition === "personal"
    ? {
        page: "Add an app and connect your account so your Bots can use it.",
        search: "Search by name. OpenBot hasn't reviewed these apps.",
      }
    : {
        page: "Add an app to make its tools available to Bots. Each person still connects their own account before a Bot reads anything.",
        search: "Search by name. Nobody here has reviewed these apps.",
      };
}

/**
 * The "More apps" section's own sentence. Admin's Plugins list only: the personal edition lists its
 * apps under Connections, with the directory as one more tile ({@link moreAppsRow}).
 */
export function moreAppsSectionDescription(_provider: PluginsProvider): string {
  return "More apps people can connect through OpenBot. Nobody here has reviewed them.";
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

/**
 * The "More apps" row's sentence in the personal edition, where the one person reading it is the
 * only one who connects anything. The same split as {@link ProviderVocabulary.directoryDescription}:
 * Composio's counts its directory and Arcade's claims no size.
 */
const PERSONAL_DIRECTORY_DESCRIPTION: Record<PluginsProvider, string> = {
  composio: "A few hundred more apps you can connect.",
  arcade: "More apps you can connect.",
};

/** Where the personal edition's one person turns connecting apps on: Settings, Setup. */
const PERSONAL_SET_UP = "Set it up in Settings under Setup.";

export function moreAppsRow(
  provider: PluginsProvider,
  configured: boolean,
  edition: Edition = "team",
): MoreAppsRow {
  const { directoryLabel, envVar, directoryDescription } = VOCABULARY[provider];
  if (!configured) {
    return {
      title: directoryLabel,
      description:
        edition === "personal"
          ? `Not set up yet. ${PERSONAL_SET_UP}`
          : `Not set up. Set ${envVar} on this deployment to browse its apps.`,
      linked: false,
    };
  }
  return {
    title: directoryLabel,
    description:
      edition === "personal"
        ? PERSONAL_DIRECTORY_DESCRIPTION[provider]
        : directoryDescription,
    linked: true,
  };
}

/**
 * The Connection card's sentence for a brokered app.
 *
 * `personal` is the app, given only by the personal edition's page: there is one person there, so
 * the sentence names their own account in the app, and an app with no account says so.
 */
export function brokeredConnectionDescription(
  _provider: PluginsProvider,
  personal?: BrokeredApp,
): string {
  if (!personal)
    return "Each person connects their own account through OpenBot.";
  if (personal.kind === "no-auth")
    return `${capitalised(personal.title)} works through OpenBot without an account.`;
  return `Connect your ${personal.title} account through OpenBot.`;
}

/**
 * The "How this is reached" row for a brokered app: its sentence and its badge.
 *
 * `personal` as above. What it says is what happens at sign-in: a consent app sends you to the
 * app's own sign-in page in your browser (`useBrokeredAccount` leaves for the broker's
 * authorization URL), so OpenBot never holds the password; a key app takes a key you paste, so
 * that sentence promises nothing about passwords; and an app with no account has nothing to sign
 * in to.
 *
 * `takesKey` is the team edition's key app, read by the same page. "There is no token to paste"
 * was said on those too, right above a Connect that asks for one.
 */
export function brokeredReach(
  _provider: PluginsProvider,
  personal?: BrokeredApp,
  takesKey = false,
): {
  description: string;
  badge: string;
} {
  const badge = "Through OpenBot";
  if (!personal) {
    return {
      description: takesKey
        ? "Each person connects their own account with a key from the app, and a Bot sees only what that person can see."
        : "This deployment holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
      badge,
    };
  }
  const { title, kind } = personal;
  return {
    description:
      kind === "consent"
        ? `You sign in to ${title} in your browser. OpenBot never sees your password.`
        : kind === "fields"
          ? `You connect with a key from your ${title} account. Your Bots use it as you.`
          : "There's nothing to sign in to.",
    badge,
  };
}

/** What disconnecting a brokered account does, said where the button is. */
export function brokeredDisconnectNote(_provider: PluginsProvider): string {
  return "Disconnecting also removes OpenBot's access to your account.";
}

/**
 * What is said where the deployment has no key for the active broker.
 *
 * `reader` is who can act on it, in the team edition. An admin's page names the variable they set; a
 * person's own Connections page names neither the variable nor the vendor in it, and says who to
 * ask, in the server's words for the same state (`BrokerUnconfiguredError`'s person sentence).
 *
 * The personal edition has no admin to ask and no grants to keep, whichever page it is: the one
 * person sets it up themselves, on Settings' Setup page, whose "More apps" row names what to set.
 */
export function brokeredKeyMissing(
  provider: PluginsProvider,
  edition: Edition = "team",
  reader: "admin" | "person" = "admin",
): string {
  if (edition === "personal")
    return `Connecting apps isn't set up yet, so you can't connect or disconnect this account here. ${PERSONAL_SET_UP}`;
  if (reader === "person")
    return "Connecting apps isn't set up yet, so this account can't be connected or disconnected here. Ask an admin to set it up.";
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
