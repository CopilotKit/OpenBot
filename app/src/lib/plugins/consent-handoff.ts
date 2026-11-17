import type { QueryClient } from "@tanstack/react-query";
import {
  appSetupQueryOptions,
  appsQueryOptions,
  directorySlug,
} from "@/lib/apps/queries";

/**
 * The step OpenBot shows before it sends somebody to an app's sign-in through Composio, and the
 * words it says there.
 *
 * WHY COMPOSIO IS NAMED HERE, AND NOWHERE ELSE OUTSIDE ADMIN. The rest of the app never names the
 * broker (`provider-vocabulary.ts`). But the next page is not ours: Composio's own Connect Link
 * page flashes by, and then Google's page says "Composio wants access to your Google Account", and
 * Slack's says "Allow Composio to access Slack". Somebody who expected OpenBot meets a stranger's
 * name at the moment they are granting access to their mail. Saying the name first, and who it is,
 * is the whole point of this step, so this is the one place a person's screen says it.
 *
 * Only on Composio. Arcade's default apps show Arcade's name the same way, but an Arcade deployment
 * may use its own OAuth apps, and this step must not name a service the page will not.
 */

/** How long the step stays before it moves on by itself, in whole seconds. */
export const CONSENT_COUNTDOWN_SECONDS = 5;

/** Where a new tab shows the step (`routes/connecting.tsx`). */
export const CONSENT_HANDOFF_PATH = "/connecting";

/** What the step needs: the app, whose sign-in page comes next, and where it goes after. */
export type ConsentHandoff = {
  /** The app's own name, as people see it: "Gmail". */
  app: string;
  /** Who runs the sign-in page that comes next, where OpenBot can tell: "Google". */
  signIn: string | null;
  /** The app's logo, where it has one. */
  logo?: string | null;
  /** The address the step sends the browser to: Composio's link for this connection. */
  url: string;
};

/*
 * WHOSE SIGN-IN PAGE COMES NEXT, BY THE APP. Only the apps whose page is known to be a big
 * provider's own; every other app falls back to "the app's sign-in page", which is always true.
 * Keyed by the directory's slug, or by the app's name squashed the same way where there is no slug.
 */
const GOOGLE = [
  "gmail",
  "googlecalendar",
  "googledrive",
  "googledocs",
  "googlesheets",
  "googleslides",
  "googlemeet",
  "googletasks",
  "googlephotos",
  "googlecontacts",
  "googleforms",
  "youtube",
];
const MICROSOFT = [
  "outlook",
  "microsoftteams",
  "onedrive",
  "sharepoint",
  "excel",
  "microsoftword",
];
const SLACK = ["slack", "slackbot"];

function squashed(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Who runs the sign-in page an app sends people to, or null where OpenBot can't say. */
export function signInPageFor(app: {
  title: string;
  slug?: string | null;
}): string | null {
  const keys = [app.slug ? squashed(app.slug) : null, squashed(app.title)];
  const has = (list: string[]) => keys.some((key) => key && list.includes(key));
  if (has(GOOGLE)) return "Google";
  if (has(SLACK)) return "Slack";
  if (has(MICROSOFT)) return "Microsoft";
  return null;
}

/*
 * THE NAMES OF THE APPS PEOPLE CONNECT MOST, BY THE KEY OPENBOT GIVES A DIRECTORY APP. Only for
 * `/desktop-return`, which is not signed in and asks the API nothing, so the key in its address is
 * all it has. An app not listed here is "your account", which is never wrong.
 */
const APP_NAMES: ReadonlyMap<string, string> = new Map([
  ["gmail", "Gmail"],
  ["googlecalendar", "Google Calendar"],
  ["googledrive", "Google Drive"],
  ["googledocs", "Google Docs"],
  ["googlesheets", "Google Sheets"],
  ["googleslides", "Google Slides"],
  ["googlemeet", "Google Meet"],
  ["googletasks", "Google Tasks"],
  ["slack", "Slack"],
  ["outlook", "Outlook"],
  ["microsoftteams", "Microsoft Teams"],
  ["onedrive", "OneDrive"],
  ["notion", "Notion"],
  ["github", "GitHub"],
  ["linear", "Linear"],
  ["jira", "Jira"],
  ["hubspot", "HubSpot"],
  ["salesforce", "Salesforce"],
  ["dropbox", "Dropbox"],
  ["asana", "Asana"],
  ["zoom", "Zoom"],
  ["figma", "Figma"],
  ["airtable", "Airtable"],
  ["youtube", "YouTube"],
]);

/** An app's name from its key ("composio-gmail" is Gmail), or null where OpenBot can't tell. */
export function appNameFromKey(key: string): string | null {
  const slug = squashed(key.replace(/^(?:composio|arcade)-/, ""));
  return APP_NAMES.get(slug) ?? null;
}

/** The words the step says, worked out from the app. One place, for the dialog and the page. */
export function consentHandoffWords(handoff: {
  app: string;
  signIn: string | null;
}): {
  heading: string;
  paragraphs: string[];
  /** The live line under them, for the seconds left. */
  countdown: (seconds: number) => string;
} {
  const { app, signIn } = handoff;
  const account =
    signIn === "Google"
      ? "your Google Account"
      : signIn === "Slack"
        ? "your Slack workspace"
        : signIn === "Microsoft"
          ? "your Microsoft account"
          : "your account";
  const next = signIn ?? `${app}'s sign-in page`;
  const paragraphs = [
    "OpenBot connects to your apps through Composio, the service that holds those connections for OpenBot.",
    `Next, ${next} will ask you to allow Composio to access ${account}. That's expected. Allowing it lets your Bots use ${app}.`,
  ];
  if (signIn === "Slack")
    paragraphs.push(
      "Slack may also say “App not approved by Slack”. That's Slack's note about Composio's app, and it's expected.",
    );
  paragraphs.push(`You can disconnect ${app} any time in Connections.`);
  return {
    heading: `Connecting ${app}`,
    paragraphs,
    countdown: (seconds) => `Taking you to ${next} in ${seconds}`,
  };
}

/**
 * Whether a consent OpenBot is about to open for this app goes through Composio, and the app's
 * name and sign-in page if so. Null otherwise: an Arcade deployment, an app OpenBot signs in to
 * itself, or a read that failed (the sign-in then opens straight away, as it always did).
 */
export async function brokeredConsentFor(
  queryClient: QueryClient,
  serverId: string,
): Promise<Omit<ConsentHandoff, "url"> | null> {
  try {
    const [setup, apps] = await Promise.all([
      queryClient.fetchQuery(appSetupQueryOptions()),
      queryClient.fetchQuery(appsQueryOptions()),
    ]);
    if (setup.directoryProvider !== "composio") return null;
    const app = apps.find((each) => each.id === serverId);
    if (app?.source !== "directory") return null;
    return {
      app: app.title,
      logo: app.logo,
      signIn: signInPageFor({
        title: app.title,
        slug: directorySlug(app.directoryEntryId),
      }),
    };
  } catch {
    return null;
  }
}

/*
 * HANDING THE STEP TO ANOTHER TAB. A sign-in that opens in a new tab claims that tab on the click
 * and fills it when the server answers. The step goes there, as one of OpenBot's own pages, and
 * what it needs is left in this origin's storage under a one-time name the page's address carries.
 *
 * NEVER THE ADDRESS ITSELF IN THE URL. A page that sent the browser wherever its own URL said would
 * let anybody send a link that passes through OpenBot to a page of their choosing. Storage can only
 * be written by OpenBot's own pages, so a link somebody made up finds nothing and goes nowhere.
 */
const STORAGE_PREFIX = "openbot.consent-handoff.";
/** How long a handed-over step is good for: long enough to load the tab, short enough to forget. */
const HANDOFF_LIFETIME_MS = 10 * 60_000;

type StoredHandoff = ConsentHandoff & { at: number };

/** Leave a step for another tab to show, and answer the name its address carries. */
export function storeConsentHandoff(handoff: ConsentHandoff): string {
  /*
   * `getRandomValues` and not `randomUUID`: the second exists only in a secure context, and an
   * OpenBot reached over plain http (a LAN address, a test origin) is not one.
   */
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  try {
    forgetStaleHandoffs();
    localStorage.setItem(
      `${STORAGE_PREFIX}${id}`,
      JSON.stringify({ ...handoff, at: Date.now() } satisfies StoredHandoff),
    );
  } catch {
    // Storage refused (a private window that allows none): the page then says there is nothing.
  }
  return id;
}

/** The address of the page that shows a step left under `id`, on this origin. */
export function consentHandoffAddress(id: string): string {
  const path = `${CONSENT_HANDOFF_PATH}#${encodeURIComponent(id)}`;
  // A document with no origin of its own (about:blank) resolves the path against its opener.
  return window.location.origin === "null"
    ? path
    : new URL(path, window.location.origin).toString();
}

/** The step left under `id`, or null where there is none, it expired, or it is not a web address. */
export function readConsentHandoff(id: string): ConsentHandoff | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredHandoff>;
    if (
      typeof stored.app !== "string" ||
      typeof stored.url !== "string" ||
      typeof stored.at !== "number" ||
      Date.now() - stored.at > HANDOFF_LIFETIME_MS
    )
      return null;
    const protocol = new URL(stored.url).protocol;
    if (protocol !== "https:" && protocol !== "http:") return null;
    return {
      app: stored.app,
      signIn: typeof stored.signIn === "string" ? stored.signIn : null,
      logo: typeof stored.logo === "string" ? stored.logo : null,
      url: stored.url,
    };
  } catch {
    return null;
  }
}

/** Forget a step once it has been used. */
export function forgetConsentHandoff(id: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
  } catch {
    // Nothing to do: it expires on its own.
  }
}

function forgetStaleHandoffs(): void {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    try {
      const at = (
        JSON.parse(localStorage.getItem(key) ?? "{}") as { at?: unknown }
      ).at;
      if (typeof at !== "number" || Date.now() - at > HANDOFF_LIFETIME_MS)
        localStorage.removeItem(key);
    } catch {
      localStorage.removeItem(key);
    }
  }
}
