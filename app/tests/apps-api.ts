import type { QueryClient } from "@tanstack/react-query";
import type {
  App,
  AppDirectoryEntry,
  AppSetup,
  DirectoryKeyVersion,
  UpdateAppRequest,
} from "@/lib/api/generated/model";
import { appKeys, type CatalogueItem } from "@/lib/apps/queries";

/**
 * The apps API as the server answers it, for a test that fakes `fetch` by hand.
 *
 * The app reads the apps added here (listApps, getApp), what can be added (listAppDirectory: the
 * catalogue and the wider directory), how apps are set up (getAppSetup) and the shortened action
 * names (getShortenedToolNames) through the client generated from api/openapi.yaml, at
 * `/api/v2/organizations/default/...`. A test describes the deployment the way `GET /api/plugins`
 * used to answer it (`servers`, `catalogue`, the flags) and the broker's directory the way
 * `GET /api/plugins/composio/apps` did, and {@link answerAppsApi} answers each read in the API's
 * shape, so a fixture says what a screen shows without restating the API's renames.
 */

/**
 * The Response a real `fetch` returns. Read before any test registers happy-dom, as each test file
 * that needs it does at its top.
 */
const NativeResponse = globalThis.Response;

const ORGANIZATION = "/api/v2/organizations/default";
export const APPS_PATH = `${ORGANIZATION}/apps`;
export const APP_DIRECTORY_PATH = `${ORGANIZATION}/app-directory`;
export const APP_SETUP_PATH = `${ORGANIZATION}/app-setup`;
export const SHORTENED_TOOL_NAMES_PATH = `${ORGANIZATION}/shortened-tool-names`;

/** One app's address in the API, written as the generated client writes it. */
export function appPath(appId: string): string {
  return `${APPS_PATH}/${encodeURIComponent(appId)}`;
}

/** An app as `GET /api/plugins` listed it in `servers`: every field optional but its id and title. */
export type TodayServer = {
  id: string;
  title: string;
  logo?: string | null;
  vendor?: string;
  url?: string;
  summary?: string;
  docsUrl?: string;
  /** `first-party`, `custom`, or the broker's name for an app from the directory. */
  provenance?: string;
  hasCredential?: boolean;
  toolsRefreshedAt?: string | null;
  lastError?: string | null;
  skippedTools?: string[];
  addedBy?: string | null;
  dynamicClient?: boolean;
  signIn?: boolean;
  /** The vendor's scheme literal a directory app was enabled with (`OAUTH2`, `API_KEY`, `NO_AUTH`). */
  authScheme?: string | null;
  entraScope?: string | null;
  accountMode?: "personal" | "shared" | null;
  sharedVendorConnected?: boolean;
  sharedOnly?: boolean;
  ownerGrants?: "any" | "admin";
  ownerGrantsChosen?: "any" | "admin" | null;
  everyBot?: boolean;
  tools?: {
    name: string;
    ref?: string;
    description?: string;
    effect?: "read" | "write";
    destructive?: boolean;
    grantedTo?: string[];
    serverId?: string;
    inputSchema?: Record<string, unknown>;
  }[];
  withdrawn?: { ref: string; name: string; grantedTo: string[] }[];
};

/** A catalogue entry as `GET /api/plugins` listed it in `catalogue`. */
export type TodayCatalogueItem = {
  key: string;
  title: string;
  vendor?: string;
  summary?: string;
  docsUrl?: string;
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin";
  perInstance?: boolean;
  oneStep?: boolean;
};

/** An app of the broker's directory as `GET /api/plugins/composio/apps` listed it. */
export type TodayDirectoryApp = {
  slug: string;
  name: string;
  description?: string;
  logo?: string | null;
  categories?: string[];
  actionCount?: number;
  classifiedCount?: number | null;
  permissionCount?: number | null;
  scopedActionCount?: number | null;
  connection: {
    kind: "consent" | "self-registering" | "fields" | "no-auth" | "unsupported";
  };
  enabled?: boolean;
  /** The same app connected with a key, for one listed as a sign-in in place of its key. */
  keyVersion?: DirectoryKeyVersion;
};

/** A deployment, described as today's routes answered it. */
export type AppsFixture = {
  servers?: readonly TodayServer[];
  catalogue?: readonly TodayCatalogueItem[];
  composioConfigured?: boolean;
  provider?: "composio" | "arcade";
  authorizesPerAction?: boolean;
  botsMayCallBack?: boolean;
  redirectUri?: string | null;
  /** The wider directory, as the broker lists it. */
  directory?: readonly TodayDirectoryApp[];
  toolNames?: Record<string, string>;
  /**
   * The most one page of a list holds, below what the reader asks for, so a test can make a list run
   * over several pages. Unset, a page holds what the reader asks for.
   */
  pageSize?: number;
};

/** One page of a list, read from where the cursor says the last page ended. */
function pageOf<T>(
  items: readonly T[],
  url: URL,
  pageSize: number | undefined,
): { items: T[]; nextCursor: string | null } {
  const start = Number(url.searchParams.get("cursor") ?? 0);
  const asked = Number(url.searchParams.get("limit") ?? items.length);
  const size = Math.max(1, Math.min(asked, pageSize ?? asked));
  const end = start + size;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}

/** The schemes whose secret a person types: a directory app enabled with one connects with a key. */
const KEY_SCHEMES = [
  "API_KEY",
  "BASIC",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
  "S2S_OAUTH2",
];

function sourceOf(server: TodayServer): App["source"] {
  if (server.provenance === "first-party") return "catalogue";
  if (server.provenance === "custom") return "address";
  if (server.provenance === "composio" || server.provenance === "arcade")
    return "directory";
  if (/^(composio|arcade):\/\//.test(server.url ?? "")) return "directory";
  return "catalogue";
}

function slugOf(server: TodayServer): string | null {
  const fromUrl = /^(?:composio|arcade):\/\/(.+)$/.exec(server.url ?? "")?.[1];
  if (fromUrl) return fromUrl;
  return /^(?:composio|arcade)-(.+)$/.exec(server.id)?.[1] ?? null;
}

/** How a person connects a directory app, read from the scheme it was enabled with. */
export function connectsWithOf(
  authScheme: string | null | undefined,
): App["connectsWith"] {
  if (authScheme === "NO_AUTH") return "nothing";
  if (authScheme && KEY_SCHEMES.includes(authScheme)) return "key";
  if (authScheme === null || authScheme === undefined) return "unreadable";
  return "sign-in";
}

/** An app in the API's shape, from the way `GET /api/plugins` listed it. */
export function appBody(server: TodayServer): App {
  const source = sourceOf(server);
  const slug = source === "directory" ? slugOf(server) : null;
  return {
    id: server.id,
    title: server.title,
    source,
    directoryEntryId:
      source === "catalogue"
        ? `catalogue:${server.id}`
        : slug
          ? `directory:${slug}`
          : null,
    address: source === "directory" ? null : (server.url ?? null),
    logo: server.logo ?? null,
    vendor: source === "directory" ? null : (server.vendor ?? ""),
    summary: server.summary ?? "",
    docsUrl: server.docsUrl ?? "",
    connectsWith:
      source === "directory" ? connectsWithOf(server.authScheme) : null,
    hasCredential: server.hasCredential ?? false,
    dynamicClient: server.dynamicClient ?? false,
    signIn: server.signIn ?? false,
    entraScope: server.entraScope ?? null,
    accountMode: server.accountMode ?? null,
    sharedAccountConnected: server.sharedVendorConnected ?? false,
    sharedOnly: server.sharedOnly ?? false,
    ownerGrants: server.ownerGrants ?? "admin",
    ownerGrantsChosen: server.ownerGrantsChosen ?? null,
    everyBot: server.everyBot ?? false,
    addedBy: server.addedBy ?? null,
    toolsRefreshedAt: server.toolsRefreshedAt ?? null,
    lastError: server.lastError ?? null,
    skippedTools: server.skippedTools ?? [],
    tools: (server.tools ?? []).map((tool) => ({
      name: tool.name,
      ref: tool.ref ?? `${server.id}/${tool.name}`,
      description: tool.description ?? "",
      effect: tool.effect ?? "write",
      destructive: tool.destructive ?? false,
      grantedTo: tool.grantedTo ?? [],
    })),
    withdrawn: server.withdrawn ?? [],
  };
}

/**
 * What the server does with an updateApp (`PATCH apps/{appId}`): it keeps each field the request
 * names on the app, and answers the changed app. `ownerGrants: null` goes back to the default for
 * the app's account, which is `admin` here.
 */
export function updateAppBody(
  server: TodayServer,
  patch: UpdateAppRequest,
): App {
  if (patch.ownerGrants !== undefined) {
    server.ownerGrants = patch.ownerGrants ?? "admin";
    server.ownerGrantsChosen = patch.ownerGrants;
  }
  if (patch.everyBot !== undefined) server.everyBot = patch.everyBot;
  return appBody(server);
}

/** How apps are set up here, in the API's shape, from the flags `GET /api/plugins` carried. */
export function appSetupBody(fixture: AppsFixture = {}): AppSetup {
  return {
    directoryAvailable: fixture.composioConfigured ?? false,
    directoryProvider: fixture.provider ?? "composio",
    redirectUri: fixture.redirectUri ?? null,
    authorizesPerAction: fixture.authorizesPerAction ?? false,
    botsMayCallBack: fixture.botsMayCallBack ?? false,
  };
}

/** Every entry of the app directory a person may see, in the API's shape and order. */
export function appDirectoryEntries(
  fixture: AppsFixture,
  source?: "catalogue" | "directory",
  search = "",
): AppDirectoryEntry[] {
  const servers = fixture.servers ?? [];
  const term = search.trim().toLowerCase();
  const holds = (...fields: (string | undefined)[]) =>
    !term || fields.some((field) => field?.toLowerCase().includes(term));
  const catalogue: AppDirectoryEntry[] =
    source === "directory"
      ? []
      : (fixture.catalogue ?? [])
          .filter((item) => holds(item.key, item.title, item.summary))
          .map((item) => ({
            id: `catalogue:${item.key}`,
            source: "catalogue",
            title: item.title,
            summary: item.summary ?? "",
            appId: servers.some((server) => server.id === item.key)
              ? item.key
              : null,
            vendor: item.vendor ?? "",
            docsUrl: item.docsUrl ?? "",
            auth: item.auth,
            perInstance: item.perInstance ?? false,
            oneStep: item.oneStep ?? false,
          }));
  const directory: AppDirectoryEntry[] =
    source === "catalogue"
      ? []
      : (fixture.directory ?? [])
          .filter((app) => app.connection.kind !== "unsupported")
          .filter((app) => holds(app.slug, app.name, app.description))
          .map((app) => {
            const added = servers.find((server) => slugOf(server) === app.slug);
            return {
              id: `directory:${app.slug}`,
              source: "directory",
              title: app.name,
              summary: app.description ?? "",
              appId:
                added?.id ??
                (app.enabled
                  ? `${fixture.provider ?? "composio"}-${app.slug}`
                  : null),
              logo: app.logo ?? null,
              categories: app.categories ?? [],
              actionCount: app.actionCount ?? 0,
              classifiedCount: app.classifiedCount ?? null,
              permissionCount: app.permissionCount ?? null,
              scopedActionCount: app.scopedActionCount ?? null,
              connectsWith:
                app.connection.kind === "fields"
                  ? "key"
                  : app.connection.kind === "no-auth"
                    ? "nothing"
                    : "sign-in",
              ...(app.keyVersion ? { keyVersion: app.keyVersion } : {}),
            };
          });
  return [...catalogue, ...directory];
}

/** The catalogue as `catalogueQueryOptions` hands it to a screen. */
export function catalogueItems(fixture: AppsFixture): CatalogueItem[] {
  return (fixture.catalogue ?? []).map((item) => ({
    key: item.key,
    title: item.title,
    vendor: item.vendor ?? "",
    summary: item.summary ?? "",
    docsUrl: item.docsUrl ?? "",
    auth: item.auth,
    perInstance: item.perInstance ?? false,
    oneStep: item.oneStep ?? false,
  }));
}

/**
 * Seed a test's query client with what a screen's app reads would have answered (the apps, the
 * catalogue and how apps are set up), for a test that renders a screen without faking `fetch`.
 */
export function seedAppReads(client: QueryClient, fixture: AppsFixture): void {
  client.setQueryData(appKeys.list(), (fixture.servers ?? []).map(appBody));
  client.setQueryData(appKeys.catalogue(), catalogueItems(fixture));
  client.setQueryData(appKeys.setup(), appSetupBody(fixture));
}

/**
 * The server's answer to one of the app's reads of the apps API, or undefined for any other
 * request. A list runs over several pages where the fixture sets `pageSize`.
 */
export function answerAppsApi(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fixture: AppsFixture,
): Response | undefined {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") return undefined;
  const url = new URL(String(input), "http://openbot.invalid");
  const path = url.pathname;
  if (path === APPS_PATH) {
    const page = pageOf(
      (fixture.servers ?? []).map(appBody),
      url,
      fixture.pageSize,
    );
    return NativeResponse.json({
      apps: page.items,
      nextCursor: page.nextCursor,
    });
  }
  /*
   * One app (getApp), and nothing below it: an app's shared account and its other reads under
   * `apps/{appId}/...` are another area's, answered by its own helper.
   */
  const below = path.startsWith(`${APPS_PATH}/`)
    ? path.slice(APPS_PATH.length + 1)
    : null;
  if (below !== null && !below.includes("/")) {
    const appId = decodeURIComponent(below);
    const found = (fixture.servers ?? []).find((server) => server.id === appId);
    return found
      ? NativeResponse.json(appBody(found))
      : NativeResponse.json(
          {
            type: "https://open.bot/errors/app-not-found",
            title: "App not found.",
            status: 404,
            detail: "That app hasn't been added.",
            code: "APP_NOT_FOUND",
            category: "not_found",
            retryable: false,
            requestId: "req_test",
            traceId: "trace_test",
          },
          { status: 404 },
        );
  }
  if (path === APP_DIRECTORY_PATH) {
    const source = url.searchParams.get("source") as
      | "catalogue"
      | "directory"
      | null;
    const page = pageOf(
      appDirectoryEntries(
        fixture,
        source ?? undefined,
        url.searchParams.get("search") ?? "",
      ),
      url,
      fixture.pageSize,
    );
    return NativeResponse.json({
      entries: page.items,
      nextCursor: page.nextCursor,
    });
  }
  if (path === APP_SETUP_PATH)
    return NativeResponse.json(appSetupBody(fixture));
  if (path === SHORTENED_TOOL_NAMES_PATH)
    return NativeResponse.json({ names: fixture.toolNames ?? {} });
  return undefined;
}
