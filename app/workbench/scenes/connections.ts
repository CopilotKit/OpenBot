/*
 * Settings → Connections in the personal edition, as OpenBot Desktop shows it on a Mac in dark mode:
 * "Your apps" (Parallel Search, on; Slack, connected), "Add an app" (the catalogue's other entries
 * and the broker's Browse apps tile), and the Vault row under them.
 *
 * The page (app/src/routes/_authed/_app/connections.index.tsx) builds its rows from five reads:
 * listApps (what is added), the catalogue (listAppDirectory, source=catalogue), getAppSetup (the
 * broker's directory, for Browse apps), listConnections for "me" (Slack's account), and the linked
 * accounts with their providers. The deployment answers `edition: "personal"`, which picks
 * personalConnectionRows (app/src/lib/connections/rows.ts): an added catalogue app that needs no
 * account reads On, a connected sign-in app Connected, and the rest go under Add an app.
 *
 * The scene exists for the workbench's Spacing check: the window buttons sit over the strip's top
 * here, beside the inset panel's rounded corner. Made-up data only.
 */

import { getListAppsResponseMock } from "@/lib/api/generated/apps/apps.msw";
import type {
  App,
  AppDirectoryPage,
  AppPage,
  AppSetup,
  CatalogueAppEntry,
  ConnectionPage,
  Deployment,
  LinkedAccountPage,
  LinkedAccountProviderPage,
} from "@/lib/api/generated/model";
import { getGetDeploymentResponseMock } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import type {
  ApiAnswer,
  ApiRoute,
  AppScene,
} from "../../../desktop/workbench/appContract";
import { DEFAULT_SESSION, SESSION_ROUTES } from "../session";

const ROUTES = {
  apps: "GET /api/v2/organizations/:organizationId/apps",
  directory: "GET /api/v2/organizations/:organizationId/app-directory",
  setup: "GET /api/v2/organizations/:organizationId/app-setup",
  connections:
    "GET /api/v2/organizations/:organizationId/people/:personId/connections",
  links:
    "GET /api/v2/organizations/:organizationId/people/:personId/linked-accounts",
  providers:
    "GET /api/v2/organizations/:organizationId/linked-account-providers",
} as const satisfies Record<string, ApiRoute>;

const value = (body: unknown): ApiAnswer => ({ mode: "value", body });

/** One catalogue entry: `key` is also the id of the app it is added as. */
function entry(
  key: string,
  title: string,
  summary: string,
  auth: CatalogueAppEntry["auth"],
  added: boolean,
): CatalogueAppEntry {
  return {
    id: `catalogue:${key}`,
    source: "catalogue",
    title,
    summary,
    appId: added ? key : null,
    vendor: title.replace(/ \(API key\)$/, ""),
    docsUrl: "https://docs.example.com/apps",
    auth,
    perInstance: false,
    oneStep: auth !== "deployment-bearer",
  };
}

/** The catalogue, in its order. Parallel Search and Slack are added. */
const CATALOGUE = [
  entry(
    "parallel-search",
    "Parallel Search",
    "Search the public web and read pages. No account needed.",
    "none",
    true,
  ),
  entry(
    "slack",
    "Slack",
    "Read and post in the channels you are in.",
    "user-oauth",
    true,
  ),
  entry(
    "parallel-search-authenticated",
    "Parallel Search (API key)",
    "Search the public web with your own Parallel key.",
    "deployment-bearer",
    false,
  ),
  entry(
    "exa",
    "Exa Search",
    "Public-web search and page reading. Free access without a key.",
    "none",
    false,
  ),
  entry(
    "exa-authenticated",
    "Exa Search (API key)",
    "Public-web search and page reading with your own Exa key.",
    "deployment-bearer",
    false,
  ),
  entry(
    "firecrawl",
    "Firecrawl",
    "Turn a web page into clean text. Free access without a key.",
    "none",
    false,
  ),
  entry(
    "firecrawl-authenticated",
    "Firecrawl (API key)",
    "Turn web pages into clean text with your own Firecrawl key.",
    "deployment-bearer",
    false,
  ),
] satisfies CatalogueAppEntry[];

const DIRECTORY = {
  entries: CATALOGUE,
  nextCursor: null,
} satisfies AppDirectoryPage;

/** An added app, from the generated mock's catalogue app with this entry's words. */
function added(key: string, signIn: boolean): App {
  const base = getListAppsResponseMock().apps[1] as App;
  const item = CATALOGUE.find((e) => e.id === `catalogue:${key}`);
  return {
    ...base,
    id: key,
    title: item?.title ?? key,
    source: "catalogue",
    directoryEntryId: `catalogue:${key}`,
    address: `https://mcp.example.com/${key}`,
    vendor: item?.vendor ?? key,
    summary: item?.summary ?? "",
    docsUrl: "https://docs.example.com/apps",
    signIn,
    addedBy: "sam@example.com",
    tools: [],
  };
}

const APPS = {
  apps: [added("parallel-search", false), added("slack", true)],
  nextCursor: null,
} satisfies AppPage;

/** The broker's directory is set up, so Add an app ends with Browse apps. */
const SETUP = {
  directoryAvailable: true,
  directoryProvider: "composio",
  redirectUri: "https://openbot.example.com/api/plugins/oauth/callback",
  authorizesPerAction: false,
  botsMayCallBack: true,
} satisfies AppSetup;

/** Sam's own Slack account. */
const CONNECTIONS = {
  connections: [
    {
      appId: "slack",
      connectedAt: "2026-11-12T09:14:00.000Z",
      revoked: false,
      scope: null,
      check: {
        verified: true,
        verifiedAt: "2026-11-21T08:02:51.000Z",
        checkedAction: "SLACK_LIST_CHANNELS",
        checkable: true,
      },
      canAddAccount: false,
    },
  ],
  nextCursor: null,
} satisfies ConnectionPage;

const NO_LINKS = {
  linkedAccounts: [],
  nextCursor: null,
} satisfies LinkedAccountPage;
const NO_PROVIDERS = {
  linkedAccountProviders: [],
  nextCursor: null,
} satisfies LinkedAccountProviderPage;

/** The personal edition: one person on their own computer. */
const PERSONAL = {
  ...getGetDeploymentResponseMock(),
  edition: "personal",
  localEvaluation: false,
  authProviders: ["google", "microsoft"],
  ssoConfigured: false,
  ssoRequired: false,
  hostedSignIn: false,
} satisfies Deployment;

const OWNER = { ...DEFAULT_SESSION, role: "owner" } as const;

export const CONNECTIONS_SCENES: readonly AppScene[] = [
  {
    kind: "app",
    id: "app-settings-connections",
    title: "Connections",
    group: "App: Settings",
    start: {
      route: "/connections",
      host: "desktop",
      session: OWNER,
      // Sam chose dark in the Theme setting (app/src/lib/theme.ts), whatever the window's theme.
      storage: { [THEME_STORAGE_KEY]: "dark" },
      api: {
        [SESSION_ROUTES.deployment]: value(PERSONAL),
        [ROUTES.apps]: value(APPS),
        [ROUTES.directory]: value(DIRECTORY),
        [ROUTES.setup]: value(SETUP),
        [ROUTES.connections]: value(CONNECTIONS),
        [ROUTES.links]: value(NO_LINKS),
        [ROUTES.providers]: value(NO_PROVIDERS),
      },
    },
  },
];
