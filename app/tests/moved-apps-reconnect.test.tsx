import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import {
  CreateAppBody,
  CreateAppResponse,
} from "@/lib/api/generated/apps/apps.zod";
import {
  ConfirmConnectionResponse,
  ConnectAppBody,
  ConnectAppResponse,
  ListConnectionsResponse,
} from "@/lib/api/generated/connections/connections.zod";
import {
  CreateCredentialBody,
  CreateCredentialResponse,
} from "@/lib/api/generated/credentials/credentials.zod";
import type {
  Import,
  PersonalAiConnection,
  ReconnectApp,
} from "@/lib/api/generated/model";
import {
  GetPersonalAiConnectionResponse,
  ReplacePersonalAiConnectionBody,
} from "@/lib/api/generated/models/models.zod";
import { ListImportsResponse } from "@/lib/api/generated/moving-to-openbot-cloud/moving-to-openbot-cloud.zod";
import {
  GetPreferencesResponse,
  UpdatePreferencesBody,
} from "@/lib/api/generated/people/people.zod";
import { personBody } from "./accounts-api";
import { type AppsFixture, answerAppsApi, appBody } from "./apps-api";
import { connectionBody } from "./connections-api";
import {
  MEMBERS_PATH,
  membersResponse,
  organizationMember,
} from "./organizations-api";

/**
 * After a move to OpenBot Cloud, the apps the move listed to connect again (their sign-ins stay on
 * the person's computer) stay in front of the person until each is connected or dismissed.
 *
 * The whole app on its real route tree, in a real browser, against a server held in this test (so
 * what it holds survives a reload) answering at the API's addresses, every answer checked against
 * the generated response schema and every body the app sends against the request schema:
 *
 * - The reconnect list (`/reconnect`) lists both apps. Reconnect on one opens its page with a way
 *   back; once it is connected (a browser's sign-in coming back to Connections) the person is back
 *   on the list with that app marked Reconnected and the other still offering Reconnect. A reload
 *   keeps that. The last one connected (the sign-in coming back to the app's own page) takes them
 *   home, where nothing is left to say.
 * - A move names an app as the computer knew it (`gmail`); here it is the app added from
 *   `directory:gmail`, with OpenBot Cloud's own id (`composio-gmail`), and that is the page it opens.
 * - An app the organization hasn't added waits for an admin, said on its row, even when OpenBot
 *   Desktop opens `/reconnect/<appId>` for it. An admin's Reconnect adds it first; a refused add
 *   comes back to the list and says so.
 * - Home says how many are left and leads to the list; Connections says it in one row.
 * - Dismissing an app removes it and saves `moved-app-<id>` to the person's dismissed notices; a
 *   reload keeps it gone. A sign-in that failed leaves them on Connections with the failure said.
 * - An OpenBot that takes no moves (404) shows none of it, and no error.
 *
 *   OPENBOT_APP_BROWSER=1 OPENBOT_APP_ENGINES=chromium,webkit bun test app/tests/moved-apps-reconnect.test.tsx
 *
 * With OPENBOT_APP_SHOTS=<dir> each screen is saved as moved-apps-<screen>-<engine>-<theme>-<width>.png.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";
const ME = `${ORGANIZATION}/people/me`;
/** The organization's people: a member says who its owner and admin are. */
const ORGANIZATION_MEMBERS = [
  organizationMember("Sam Rivera", "sam@example.com", "member"),
  organizationMember("Ines Duarte", "ines@example.com", "admin"),
  organizationMember("Priya Raman", "priya@example.com", "owner"),
];
/** What a member reads about an app only an admin can turn on, with who the admins are. */
const SLACK_WAITS =
  "An admin has to turn Slack on before you can connect it: Priya Raman (priya@example.com) or Ines Duarte (ines@example.com).";

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
type Theme = "light" | "dark";
type Window = { width: number; height: number };

const svg = (body: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`).toString("base64")}`;
/** Gmail's mark, drawn small, as the app directory gives it. */
const GMAIL_ICON = svg(
  '<path fill="#4285f4" d="M2 6.5V18a1.5 1.5 0 0 0 1.5 1.5H6V10l-4-3.5z"/><path fill="#34a853" d="M18 19.5h2.5A1.5 1.5 0 0 0 22 18V6.5L18 10z"/><path fill="#ea4335" d="M6 10V5.5L12 10l6-4.5V10l-6 4.5z"/><path fill="#fbbc04" d="M18 5.5V10l4-3.5V6a1.5 1.5 0 0 0-2.4-1.2z"/><path fill="#c5221f" d="M2 6v.5L6 10V5.5L4.4 4.3A1.5 1.5 0 0 0 2 6z"/>',
);
const CALENDAR_LOGO = svg(
  '<rect x="3" y="4" width="18" height="17" rx="2" fill="#fff" stroke="#4285f4" stroke-width="2"/><rect x="3" y="4" width="18" height="5" fill="#4285f4"/><text x="12" y="18.5" font-size="8" font-family="Arial" font-weight="700" text-anchor="middle" fill="#4285f4">31</text>',
);

const GMAIL: ReconnectApp = {
  appId: "gmail",
  appName: "Gmail",
  accountLabel: "sam@example.com",
  iconUrl: GMAIL_ICON,
  botNames: ["Inbox", "Research"],
};
/** No icon from the move: the app's own logo is drawn. */
const CALENDAR: ReconnectApp = {
  appId: "googlecalendar",
  appName: "Google Calendar",
  accountLabel: "sam@example.com",
  botNames: ["Scheduler"],
};

/** In the directory, and not added in this organization yet. */
const SLACK: ReconnectApp = {
  appId: "slack",
  appName: "Slack",
  accountLabel: "Acme workspace",
  botNames: ["Inbox"],
};
/** Not added here, and the directory refuses to add it. */
const LINEAR: ReconnectApp = { appId: "linear", appName: "Linear" };

/** Where every sign-in starts in this test: a vendor's page, drawn empty. */
const SIGN_IN = "https://sign-in.vendor.test";

/** From the directory, connected with a key. */
const FIREFLIES: ReconnectApp = {
  appId: "fireflies",
  appName: "Fireflies",
  accountLabel: "sam@example.com",
  botNames: ["Scheduler"],
};
/** From the directory, whose list entry can't say how it connects; it takes a key. */
const POSTHOG: ReconnectApp = { appId: "posthog", appName: "PostHog" };
/** Added by its address, and each person signs in to it. */
const DOCS: ReconnectApp = {
  appId: "docs-search",
  appName: "Docs Search",
  botNames: ["Research"],
};
/** Built in, and each person signs in to it. */
const DRIVE: ReconnectApp = { appId: "gdrive", appName: "Google Drive" };

/** The apps those connect to here, added beside the organization's others for the tests that ask. */
const KEY_APPS = [
  {
    id: "composio-fireflies",
    title: "Fireflies",
    provenance: "composio",
    url: "composio://fireflies",
    authScheme: "API_KEY",
    accountMode: "personal" as const,
    summary: "Read meeting notes.",
  },
  {
    id: "composio-posthog",
    title: "PostHog",
    provenance: "composio",
    url: "composio://posthog",
    authScheme: null,
    accountMode: "personal" as const,
    summary: "Read product analytics.",
  },
];
const SIGN_IN_APPS = [
  {
    id: "docs-search",
    title: "Docs Search",
    provenance: "custom",
    url: "https://mcp.docs.test/mcp",
    signIn: true,
  },
  { id: "gdrive", title: "Google Drive", provenance: "first-party" },
];
const DRIVE_ENTRY = {
  key: "gdrive",
  title: "Google Drive",
  vendor: "Google",
  summary: "Read and search your files.",
  auth: "user-oauth" as const,
};

/** An app from the directory, as OpenBot Cloud adds it: its own id, from the entry it came from. */
function directoryApp(slug: string, title: string, summary: string) {
  return {
    id: `composio-${slug}`,
    title,
    provenance: "composio",
    url: `composio://${slug}`,
    authScheme: "OAUTH2",
    accountMode: "personal" as const,
    summary,
  };
}

/**
 * The apps as the organization has them: from the directory, signed in to as each person, each with
 * OpenBot Cloud's own id (`composio-gmail`) and the entry it came from (`directory:gmail`), which is
 * how a move, naming the app `gmail`, finds it.
 */
const APPS: AppsFixture = {
  composioConfigured: true,
  servers: [
    {
      id: "composio-gmail",
      title: "Gmail",
      provenance: "composio",
      url: "composio://gmail",
      authScheme: "OAUTH2",
      accountMode: "personal",
      logo: GMAIL_ICON,
      summary: "Read and send mail.",
    },
    {
      id: "composio-googlecalendar",
      title: "Google Calendar",
      provenance: "composio",
      url: "composio://googlecalendar",
      authScheme: "OAUTH2",
      accountMode: "personal",
      logo: CALENDAR_LOGO,
      summary: "Read and add events.",
    },
    directoryApp("notion", "Notion", "Read and write pages."),
  ],
  /*
   * The directory's apps not added here yet, as listAppDirectory lists them: Slack, and Linear,
   * which the directory lists and then refuses to add. An app added by its address is never in it.
   */
  directory: [
    { slug: "slack", name: "Slack", connection: { kind: "consent" } },
    { slug: "linear", name: "Linear", connection: { kind: "consent" } },
  ],
};

/** OpenBot Cloud's sentence for a carried app its organization doesn't allow. */
const NOT_ALLOWED =
  "Your organization doesn't allow Team wiki yet. Ask an admin to approve it, then connect it here.";
/** Meant to come across connected with its key; the organization here doesn't allow it. */
const TEAM_WIKI: ReconnectApp = {
  appId: "team-wiki",
  appName: "Team wiki",
  botNames: ["Research"],
  reason: NOT_ALLOWED,
};

/** A server added by its address on the person's computer: not in the directory. */
const S4_ORDERS: ReconnectApp = {
  appId: "s4-orders",
  appName: "S4 Orders",
  botNames: ["Order Desk"],
};
/** That server once an admin has added it here, with the organization's key. */
const S4_ORDERS_HERE = {
  id: "s4-orders",
  title: "S4 Orders",
  provenance: "custom",
  url: "https://orders.s4.test/mcp",
  signIn: false,
};
/** An entry of OpenBot's own catalogue reached with a key an admin gives for everybody. */
const EXA_ENTRY = {
  key: "exa",
  title: "Exa",
  vendor: "Exa",
  summary: "Search the web.",
  auth: "deployment-bearer" as const,
};
const EXA: ReconnectApp = { appId: "exa", appName: "Exa" };
/** The id the vault gives the nth credential saved in a test: a UUID, as the API's are. */
const credentialId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A directory app on the organization's one shared account, connected. */
const NOTION_SHARED = {
  ...directoryApp("notion", "Notion", "Read and write pages."),
  accountMode: "shared" as const,
  sharedVendorConnected: true,
};
const NOTION: ReconnectApp = { appId: "notion", appName: "Notion" };

/** A finished move, as listImports answers it, listing `reconnect` and `carried`. */
function finishedMove(
  reconnect: ReconnectApp[],
  carried: Import["carried"] = undefined,
): Import {
  return {
    id: "imp_0e1f2a3b4c5d6f1d",
    status: "imported",
    sourceName: "Sam's MacBook",
    createdAt: "2026-11-21T10:00:00Z",
    finishedAt: "2026-11-21T10:03:12Z",
    recipientKey: {
      kty: "RSA",
      alg: "RSA-OAEP-256",
      kid: "imp_0e1f2a3b4c5d6f1d",
      e: "AQAB",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    },
    maxBundleBytes: 10737418240,
    maxPartBytes: 33554432,
    receivedParts: [1],
    reconnect,
    ...(carried ? { carried } : {}),
  } as Import;
}

const NOT_FOUND = {
  type: "https://open.bot/errors/not-found",
  title: "Not found.",
  status: 404,
  detail: "Not found.",
  code: "NOT_FOUND",
};
/** The spec's MoveUnavailable answer, as any OpenBot but Cloud gives it. */
const MOVE_UNAVAILABLE = {
  type: "https://open.bot/errors/move-unavailable",
  title: "Moving isn't available here.",
  status: 404,
  detail: "Importing is available only on OpenBot Cloud.",
  code: "MOVE_UNAVAILABLE",
};

type Answer = { status: number; json: unknown };

const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as { components: { examples: Record<string, { value: unknown }> } };
/** The person's AI connection as the spec's example says it: OpenBot Cloud, with none yet. */
function personalAiNone(): PersonalAiConnection {
  return GetPersonalAiConnectionResponse.parse(
    structuredClone(
      spec.components.examples.PersonalAiConnectionNoneExample?.value,
    ),
  ) as PersonalAiConnection;
}
const GOOD_KEY = "sk-ant-api03-good";

/** One OpenBot Cloud's server, as far as these screens ask it. */
class FakeServer {
  /** The person's moves, or null on an OpenBot that takes none. */
  imports: Import[] | null;
  connected = new Set<string>();
  dismissed: string[] = [];
  /** Every preferences change the app sent, as its body was checked. */
  saves: unknown[] = [];
  /** Every request this server could not answer. */
  unanswered: string[] = [];
  /** How many times the app read the organization's members. */
  membersAsks = 0;
  /** The organization's apps, which an admin's add grows. */
  apps: AppsFixture = { ...APPS, servers: [...(APPS.servers ?? [])] };
  /** Every app added, by the entry it was asked for. */
  added: string[] = [];
  /** The ids of every credential an admin saved. */
  credentials: string[] = [];
  role: "member" | "admin";
  /**
   * The person's own AI on OpenBot Cloud, where one is required: null where the server answers
   * none (404, as an OpenBot that requires none), else the connection as the server keeps it.
   */
  ai: PersonalAiConnection | null = null;
  /**
   * Whether people sign in with their OpenBot by CopilotKit account (`hostedSignIn`): OpenBot
   * Cloud, the one OpenBot that takes a move. False is a self-hosted OpenBot or the personal edition.
   */
  hosted: boolean;
  /** How many times the app asked for the person's moves. */
  importAsks = 0;
  /** Every API request answered 400 or more, as the browser's network panel would list it. */
  failed: string[] = [];
  /** Every connect started, by app, and whether it carried a typed key. */
  connects: { appId: string; key: boolean }[] = [];
  /** The apps that take a key, whatever the app list says about how they connect. */
  keyApps = new Set<string>();
  /**
   * The organization's apps switch. Locked down unless a test opens it: the tests here that pin a
   * member waiting for an admin pin it locked down. Open, a member adds an app as an admin does.
   */
  lockedDown = true;
  /** Holds the directory's answers until released: the seconds a real directory search takes. */
  directoryHeld: Promise<void> | null = null;

  constructor(
    imports: Import[] | null,
    role: "member" | "admin" = "member",
    hosted = true,
  ) {
    this.imports = imports;
    this.role = role;
    this.hosted = hosted;
  }

  async answer(request: Request): Promise<Answer> {
    const answer = await this.answerOf(request);
    if (answer.status >= 400)
      this.failed.push(
        `${answer.status} ${request.method()} ${new URL(request.url()).pathname}`,
      );
    return answer;
  }

  async answerOf(request: Request): Promise<Answer> {
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (path === `${ME}/ai-connection` && this.ai) {
      if (method === "PUT") {
        const sent = request.postDataJSON() as Record<string, unknown>;
        const input = ReplacePersonalAiConnectionBody.parse(sent);
        this.ai = GetPersonalAiConnectionResponse.parse({
          ...this.ai,
          connection: {
            provider: input.provider,
            login: input.login,
            model: null,
            endpointHost: null,
            keySet: true,
            ready: true,
            source: "stored",
            editable: true,
            saved: [
              {
                provider: input.provider,
                login: input.login,
                endpointHost: null,
              },
            ],
            changedAt: "2026-11-22T10:00:00.000Z",
          },
          uses: "personal",
        }) as PersonalAiConnection;
      }
      return { status: 200, json: this.ai };
    }
    if (path === `${ORGANIZATION}/imports` && method === "GET") {
      this.importAsks += 1;
      if (this.imports === null) return { status: 404, json: MOVE_UNAVAILABLE };
      return {
        status: 200,
        json: ListImportsResponse.parse({
          items: this.imports,
          nextCursor: null,
        }),
      };
    }
    if (path === `${ME}/connections` && method === "GET")
      return {
        status: 200,
        json: ListConnectionsResponse.parse({
          connections: [...this.connected].map((serverId) =>
            connectionBody({
              serverId,
              verified: true,
              verifiedAt: "2026-11-22T09:00:00.000Z",
              probe: null,
              checkable: true,
            }),
          ),
          nextCursor: null,
        }),
      };
    if (path === `${ME}/preferences` && method === "GET")
      return { status: 200, json: this.preferences() };
    if (path === `${ME}/preferences` && method === "PATCH") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const sent = request.postDataJSON() as Record<string, unknown>;
      const body = UpdatePreferencesBody.parse(sent);
      for (const key of Object.keys(sent))
        expect(Object.keys(body)).toContain(key);
      this.saves.push(sent);
      for (const notice of body.dismissedNotices ?? [])
        if (!this.dismissed.includes(notice)) this.dismissed.push(notice);
      return { status: 200, json: this.preferences() };
    }
    if (path === ME && method === "GET")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "sam",
            name: "Sam Rivera",
            email: "sam@example.com",
            role: this.role,
            onboarding: { step: 1, completedAt: "2026-11-21T10:05:00.000Z" },
          }),
          openbotVersion: "v1.2.0",
        },
      };
    if (path === `${ORGANIZATION}/deployment`)
      return {
        status: 200,
        json: {
          generativeUi: true,
          selfHostBanner: false,
          localEvaluation: false,
          edition: "team",
          authProviders: [],
          ssoConfigured: false,
          ssoRequired: false,
          hostedSignIn: this.hosted,
        },
      };
    if (path === `${ORGANIZATION}/settings/apps` && method === "GET")
      return { status: 200, json: { lockedDown: this.lockedDown } };
    if (path === `${ORGANIZATION}/bots` && method === "GET")
      return { status: 200, json: { bots: [], nextCursor: null } };
    if (path === `${ORGANIZATION}/conversations` && method === "GET")
      return { status: 200, json: { conversations: [], nextCursor: null } };
    // No GitHub or Slack accounts to link here, as an OpenBot without them answers.
    if (path.includes("/linked-account"))
      return {
        status: 503,
        json: {
          ...NOT_FOUND,
          status: 503,
          code: "LINKED_ACCOUNTS_UNAVAILABLE",
        },
      };
    // A key an admin types for an app reached with one: kept, and answered without its secret.
    if (path === `${ORGANIZATION}/credentials` && method === "POST") {
      expect(this.role).toBe("admin");
      const sent = CreateCredentialBody.parse(request.postDataJSON());
      const id = credentialId(this.credentials.length + 1);
      this.credentials.push(id);
      return {
        status: 201,
        json: CreateCredentialResponse.parse({
          id,
          kind: sent.kind,
          provider: sent.provider,
          keyId: sent.keyId,
          metadata: sent.metadata ?? {},
          createdAt: "2026-11-24T12:00:00.000Z",
          revokedAt: null,
        }),
      };
    }
    if (path === `${ORGANIZATION}/apps` && method === "POST") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      // An admin adds apps; so does anybody while apps are open.
      if (this.lockedDown) expect(this.role).toBe("admin");
      const sent = request.postDataJSON() as Record<string, unknown>;
      CreateAppBody.parse(sent);
      // A server added by its address: reached with the organization's key, nobody signs in.
      if (sent.from === "address") {
        const title = String(sent.title);
        this.added.push(`address:${title}`);
        const server = {
          id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          title,
          provenance: "custom",
          url: String(sent.url),
          signIn: false,
        };
        this.apps.servers = [...(this.apps.servers ?? []), server];
        return { status: 201, json: CreateAppResponse.parse(appBody(server)) };
      }
      expect(sent.from).toBe("directory");
      const entry = String(sent.directoryEntryId);
      this.added.push(entry);
      /*
       * Fireflies, which the directory offers as its sign-in (the vendor's own server): where that
       * server is already here, the add is refused as already added, naming it, as OpenBot Cloud
       * 1.2.0 answers.
       */
      const signIn = (this.apps.servers ?? []).find(
        (server) =>
          "url" in server && server.url === "https://api.fireflies.ai/mcp",
      );
      if (entry === "directory:fireflies" && signIn)
        return {
          status: 409,
          json: {
            type: "https://open.bot/errors/app-already-added",
            title: "That app is already added.",
            status: 409,
            detail: `That server is already here, as ${signIn.title}.`,
            code: "APP_ALREADY_ADDED",
            appId: signIn.id,
          },
        };
      // An entry of OpenBot's own catalogue: added as its key, with the key it was given, if any.
      const listed = (this.apps.catalogue ?? []).find(
        (item) => `catalogue:${item.key}` === entry,
      );
      if (listed) {
        if (listed.auth === "deployment-bearer")
          expect(this.credentials).toContain(String(sent.credentialId));
        const server = {
          id: listed.key,
          title: listed.title,
          provenance: "first-party",
          url: `https://${listed.key}.vendor.test/mcp`,
        };
        this.apps.servers = [...(this.apps.servers ?? []), server];
        return { status: 201, json: CreateAppResponse.parse(appBody(server)) };
      }
      // Slack is in the directory; nothing else asked for here is.
      if (entry !== "directory:slack")
        return {
          status: 404,
          json: {
            ...NOT_FOUND,
            detail: "That app isn't in the directory.",
          },
        };
      const slack = directoryApp("slack", "Slack", "Read and send messages.");
      this.apps.servers = [...(this.apps.servers ?? []), slack];
      return { status: 201, json: CreateAppResponse.parse(appBody(slack)) };
    }
    const connection =
      /^\/api\/v2\/organizations\/default\/people\/me\/connections\/([^/]+)\/(connect|confirm)$/.exec(
        path,
      );
    if (connection && method === "POST") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const appId = decodeURIComponent(connection[1] ?? "");
      if (connection[2] === "confirm")
        return {
          status: 200,
          json: ConfirmConnectionResponse.parse({
            connected: this.connected.has(appId),
          }),
        };
      const body = ConnectAppBody.parse(request.postDataJSON());
      this.connects.push({ appId, key: body.values !== undefined });
      return {
        status: 200,
        json: ConnectAppResponse.parse(this.start(appId, body.values)),
      };
    }
    // Who a member is told to go to for an app only an admin can turn on.
    if (path === MEMBERS_PATH && method === "GET") {
      this.membersAsks += 1;
      const members = membersResponse(url.toString(), ORGANIZATION_MEMBERS);
      return { status: members.status, json: await members.json() };
    }
    if (path === `${ORGANIZATION}/app-directory` && this.directoryHeld)
      await this.directoryHeld;
    const apps = answerAppsApi(url.toString(), { method }, this.apps);
    if (apps) return { status: apps.status, json: await apps.json() };
    this.unanswered.push(`${method} ${path}`);
    return { status: 404, json: NOT_FOUND };
  }

  /**
   * What starting a connect answers: a key app's form, then connected once the key is sent; the
   * sign-in page for everything else (a vendor's page, which this test's browser draws empty).
   */
  start(appId: string, values: Record<string, string> | undefined) {
    if (values) {
      expect(values).toEqual({ api_key: GOOD_KEY });
      this.connected.add(appId);
      return { next: "connected", verified: true, checkedAction: null };
    }
    if (this.keyApps.has(appId))
      return {
        next: "form",
        fields: [
          {
            name: "api_key",
            label: "API key",
            help: "The key from the app's settings.",
            required: true,
            secret: true,
            default: null,
          },
        ],
        guide: null,
      };
    return {
      next: "consent",
      authorizationUrl: `${SIGN_IN}/${encodeURIComponent(appId)}`,
    };
  }

  preferences() {
    return GetPreferencesResponse.parse({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
      dismissedNotices: this.dismissed,
      noticesDue: [],
      narration: null,
      skin: "openbot",
      proactive: "on",
    });
  }
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "moved-apps-reconnect.fixture.tsx")],
    target: "browser",
    // An optional map renderer a library loads only when asked to draw a map; not installed.
    external: ["maplibre-gl"],
    // `@/lib/marks` is Vite's `import.meta.glob`, so no brand marks, as in the other browser tests.
    plugins: [
      {
        name: "no-marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "no-marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "no-marks" }, () => ({
            contents: "export const markFor = () => null;",
            loader: "js",
          }));
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
      "import.meta.env.MODE": JSON.stringify("production"),
    },
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

const browsers = new Map<string, Browser>();
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      // The CI job installs full Chromium without the headless shell.
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

/** The page at `path`, its server answering from `server`. */
async function open(
  path: string,
  server: FakeServer,
  engine: string,
  theme: Theme = "light",
  window: Window = WIDE,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  // Nothing leaves for another site: a vendor's page is an empty one.
  await page.context().route(
    (url) => url.origin !== ORIGIN && url.protocol.startsWith("http"),
    (route) => route.fulfill({ contentType: "text/html", body: "" }),
  );
  await page.route(`${ORIGIN}/**`, async (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/app.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) {
      const { status, json } = await server.answer(route.request());
      return route.fulfill({
        status,
        json,
        headers:
          status >= 400 ? { "content-type": "application/problem+json" } : {},
      });
    }
    if (where.includes(".")) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Style the page for every class it draws now. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shoot(
  page: Page,
  screen: string,
  engine: string,
  theme: Theme,
  window: Window,
) {
  if (!shots) return;
  await style(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(
      shots,
      `moved-apps-${screen}-${engine}-${theme}-${window.width}.png`,
    ),
  });
}

/** What a person would see wrong: sideways scroll, or a control cut off at the side. */
async function measured(page: Page) {
  await style(page);
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    // The page's own column (under its title) and the bars over it.
    const column = document.querySelector(
      "[data-slot=page-header]",
    )?.parentElement;
    const cut = [
      ...(column?.querySelectorAll("button, a, input, [data-moved-app] *") ??
        []),
      ...document.querySelectorAll("aside button, aside a"),
    ]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      })
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    return { sideways: document.documentElement.scrollWidth > innerWidth, cut };
  });
}
const FINE = { sideways: false, cut: [] };

const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();
const row = (page: Page, appId: string) =>
  page.locator(`[data-moved-app="${appId}"]`);
const path = (page: Page) => new URL(page.url()).pathname;

/** Connect your AI with a key, and its button. */
async function connectAi(page: Page) {
  const chooser = page.locator("[data-ai-chooser]");
  await chooser.getByRole("button", { name: /^Anthropic/ }).click();
  await chooser.getByRole("tab", { name: "Use an API key" }).click();
  await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
  await chooser.getByRole("button", { name: "Connect" }).click();
  await chooser.getByRole("status").waitFor();
  await page.locator("[data-onboarding-primary]").click();
}

/** Reconnect on the list: the app's page, its sign-in, and back to the list connected. */
async function reconnectThrough(
  page: Page,
  server: FakeServer,
  appId: string,
  cloudId: string,
) {
  await row(page, appId).getByRole("button", { name: "Reconnect" }).click();
  await page.waitForURL(`${ORIGIN}/connections/${cloudId}`);
  server.connected.add(cloudId);
  await page.goto(`${ORIGIN}/connections?connected=${cloudId}`);
  await page.waitForURL(`${ORIGIN}/reconnect`);
}

describe.skipIf(!asked)("apps to reconnect after a move", () => {
  for (const engine of engines)
    test(`the person works through the list and is taken home when done, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      const page = await open("/", server, engine);
      try {
        // Home says there is something to do, and leads to the list.
        const bar = page.getByRole("complementary", {
          name: "Apps to reconnect",
        });
        await bar.waitFor();
        expect(await bar.textContent()).toContain(
          "2 apps from your move still need reconnecting.",
        );
        await shoot(page, "home-bar", engine, "light", WIDE);
        await bar.getByRole("button", { name: "Reconnect" }).click();
        await heading(page, "Reconnect your apps");
        expect(path(page)).toBe("/reconnect");
        await row(page, "googlecalendar").waitFor();
        expect(await row(page, "gmail").textContent()).toContain(
          "sam@example.com · Used by Inbox and Research",
        );
        for (const app of ["gmail", "googlecalendar"])
          await row(page, app)
            .getByRole("button", { name: "Reconnect" })
            .waitFor();
        // No bar over the list that already says it.
        expect(await bar.count()).toBe(0);
        expect(await measured(page)).toEqual(FINE);

        // Gmail: its page, with the way back to the list, and its sign-in started by the same press.
        await row(page, "gmail")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // The move named it `gmail`; here it is the app added from `directory:gmail`.
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page.getByRole("dialog", { name: "Connecting Gmail" }).waitFor();
        // Behind the step, which hides the page from the accessibility tree while it is up.
        await page
          .getByRole("button", {
            name: "Your apps to reconnect",
            includeHidden: true,
          })
          .waitFor();
        await page
          .getByRole("heading", {
            level: 1,
            name: "Gmail",
            includeHidden: true,
          })
          .waitFor();
        // Off to Google's sign-in, which connects it; the browser's sign-in comes back to Connections.
        await page.goto("https://accounts.google.test/signin");
        server.connected.add("composio-gmail");
        await page.goto(`${ORIGIN}/connections?connected=composio-gmail`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").getByText("Reconnected").waitFor();
        expect(
          await row(page, "gmail")
            .getByRole("button", { name: "Reconnect" })
            .count(),
        ).toBe(0);
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();

        // A reload shows the same.
        await page.reload();
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        await page.getByRole("button", { name: "Go to OpenBot" }).waitFor();

        // Google Calendar, whose sign-in comes back to its own page: the last one, so home.
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/connections/composio-googlecalendar`);
        await page.goto("https://accounts.google.test/signin");
        server.connected.add("composio-googlecalendar");
        await page.goto(
          `${ORIGIN}/connections/composio-googlecalendar?status=success&connected_account_id=ca_1`,
        );
        await page.waitForURL(`${ORIGIN}/`);
        // Nothing left to say anywhere.
        await page.waitForTimeout(500);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        // The list, opened again, shows both connected and the way on.
        await page.goto(`${ORIGIN}/reconnect`);
        await row(page, "googlecalendar").getByText("Reconnected").waitFor();
        await page.getByRole("button", { name: "Done" }).click();
        await page.waitForURL(`${ORIGIN}/`);
        expect(server.saves).toEqual([]);
      } finally {
        await page.close();
      }
    }, 120_000);

  /*
   * Reported on 1.2.0-rc.1: Reconnect after the move met Connect your AI, whose button then left
   * the person on home, with no app connected and the list gone. Connect your AI comes first (OpenBot
   * Desktop opens the list, and the gate asks for the AI on the way), then the list, each app's page,
   * back to the list after each, and home after the last.
   */
  for (const engine of engines)
    test(`after the move, Connect your AI first, then the list, each app and back, then home, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      server.ai = personalAiNone();
      // Where OpenBot Desktop's "Connect your AI" opens OpenBot Cloud.
      const page = await open("/reconnect", server, engine);
      try {
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("next")).toBe("/reconnect");
        await connectAi(page);
        await heading(page, "Reconnect your apps");
        expect(path(page)).toBe("/reconnect");

        await reconnectThrough(page, server, "gmail", "composio-gmail");
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        await page.reload();
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();

        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/connections/composio-googlecalendar`);
        server.connected.add("composio-googlecalendar");
        await page.goto(
          `${ORIGIN}/connections?connected=composio-googlecalendar`,
        );
        await page.waitForURL(`${ORIGIN}/`);
      } finally {
        await page.close();
      }
    }, 120_000);

  for (const engine of engines)
    test(`an app's Reconnect that meets Connect your AI lands on that app's page once the AI is connected, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      server.ai = personalAiNone();
      // Where OpenBot Desktop's Reconnect on Gmail opens OpenBot Cloud.
      const page = await open("/reconnect/gmail", server, engine);
      try {
        await heading(page, "Connect your AI");
        await connectAi(page);
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page
          .getByRole("heading", {
            level: 1,
            name: "Gmail",
            includeHidden: true,
          })
          .waitFor();
        // Desktop's one press of Reconnect starts Gmail's sign-in too, once the AI is connected.
        await page.getByRole("dialog", { name: "Connecting Gmail" }).waitFor();
        expect(server.connects).toEqual([
          { appId: "composio-gmail", key: false },
        ]);
        // And connecting it comes back to the list, with the other still to do.
        server.connected.add("composio-gmail");
        await page.goto(`${ORIGIN}/connections?connected=composio-gmail`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").getByText("Reconnected").waitFor();
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 120_000);

  for (const engine of engines)
    test(`an app not added here waits for an admin, a dismissed app stays gone, and a failed sign-in stays on Connections, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR, SLACK])]);
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "googlecalendar").waitFor();
        // Slack isn't added in this organization, and only an admin may add it: named, owner first.
        await row(page, "slack").getByText(SLACK_WAITS).waitFor();
        await shoot(page, "member-waits", engine, "light", WIDE);
        if (shots) {
          await page.setViewportSize(PHONE);
          await shoot(page, "member-waits", engine, "light", PHONE);
          await page.setViewportSize(WIDE);
        }
        expect(
          await row(page, "slack")
            .getByRole("button", { name: "Reconnect" })
            .count(),
        ).toBe(0);
        // Opened straight from OpenBot Desktop: back to the list, never a page that isn't there.
        await page.goto(`${ORIGIN}/reconnect/slack`);
        await page.waitForURL((url) => url.pathname === "/reconnect");
        await row(page, "slack").getByText(SLACK_WAITS).waitFor();
        expect(server.added).toEqual([]);
        await row(page, "googlecalendar")
          .getByRole("button", { name: "Dismiss Google Calendar" })
          .click();
        await row(page, "googlecalendar").waitFor({ state: "detached" });
        expect(server.saves).toEqual([
          { dismissedNotices: ["moved-app-googlecalendar"] },
        ]);
        await page.reload();
        await row(page, "gmail").waitFor();
        expect(await row(page, "googlecalendar").count()).toBe(0);

        // Connections says it in one row, and it leads back to the list.
        await page.goto(`${ORIGIN}/connections`);
        const notice = page.locator("[data-moved-apps-notice]");
        await notice.waitFor();
        expect(await notice.textContent()).toContain(
          "2 apps from your move still need reconnecting",
        );
        // A sign-in that failed: nothing connected, so the person stays where the failure is said.
        await page.goto(`${ORIGIN}/reconnect/gmail`);
        await page.waitForURL(`${ORIGIN}/connections/composio-gmail`);
        await page.goto(`${ORIGIN}/connections?connected=failed`);
        await page.getByText("Couldn't connect that account.").waitFor();
        await page.waitForTimeout(500);
        expect(path(page)).toBe("/connections");
        await notice.getByRole("button", { name: "Reconnect" }).click();
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").waitFor();
      } finally {
        await page.close();
      }
    }, 120_000);

  /*
   * Reported in dogfooding: a move left about 20 apps to reconnect. Apps connected with a key come
   * across connected now and are never listed; one OpenBot Cloud couldn't connect is, with its
   * reason on its row in place of the line it would otherwise have.
   */
  for (const engine of engines)
    test(`an app that came across connected isn't listed, and one that couldn't says why on its row, in ${engine}`, async () => {
      const server = new FakeServer([
        finishedMove(
          [GMAIL, TEAM_WIKI, SLACK],
          [{ appId: "fireflies", appName: "Fireflies", botNames: ["Standup"] }],
        ),
      ]);
      const page = await open("/reconnect", server, engine);
      try {
        // OpenBot Cloud's reason, and beside it who the admins are, owner first.
        const withAdmins = `${NOT_ALLOWED} Your admins are Priya Raman (priya@example.com) and Ines Duarte (ines@example.com).`;
        await row(page, "team-wiki").getByText(withAdmins).waitFor();
        expect(
          await row(page, "team-wiki")
            .locator("[data-moved-app-reason]")
            .textContent(),
        ).toBe(withAdmins);
        // The reason says what to do, so the admin line isn't said twice.
        expect(
          await row(page, "team-wiki")
            .getByText(/An admin has to turn/)
            .count(),
        ).toBe(0);
        // Its other line is still there.
        expect(await row(page, "team-wiki").textContent()).toContain(
          "Used by Research",
        );
        // The rest as before.
        await row(page, "slack").getByText(SLACK_WAITS).waitFor();
        expect(
          await row(page, "gmail").locator("[data-moved-app-reason]").count(),
        ).toBe(0);
        // The app that came across connected is nowhere on the list.
        expect(await row(page, "fireflies").count()).toBe(0);
        expect(
          await page
            .getByText(
              "These apps were connected in OpenBot on your computer. Connect each one again here.",
            )
            .count(),
        ).toBe(1);
        for (const theme of ["light", "dark"] as const)
          for (const window of [WIDE, PHONE]) {
            await page.emulateMedia({ colorScheme: theme });
            await page.setViewportSize(window);
            await page.waitForTimeout(200);
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "list-reason", engine, theme, window);
          }
      } finally {
        await page.close();
      }
    }, 90_000);

  /*
   * Found by the move's end-to-end run: Reconnect on a server added by its address asked the
   * directory to add it, which it isn't in, and the row then said "Couldn't turn S4 Orders on here.
   * Try again in a moment." Now an admin's one press opens Add custom MCP with its name filled in
   * (the move doesn't bring the address or key), and adding it comes back to the list, done.
   */
  for (const engine of engines)
    test(`an admin's Reconnect on a server added by its address opens Add custom MCP, and adding it comes back done, in ${engine}`, async () => {
      const server = new FakeServer(
        [finishedMove([S4_ORDERS, GMAIL])],
        "admin",
      );
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "s4-orders")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL((url) => url.pathname === "/connections/new");
        const name = page.getByLabel("Name");
        await name.waitFor();
        expect(await name.inputValue()).toBe("S4 Orders");
        await page
          .getByText(
            "S4 Orders was added by its address in OpenBot on your computer. Add it here with the same address, and its key if it needs one.",
          )
          .waitFor();
        // Never asked of the directory, which doesn't have it.
        expect(server.added).toEqual([]);
        await shoot(page, "add-by-address", engine, "light", WIDE);
        await page.getByLabel("Server address").fill(S4_ORDERS_HERE.url);
        await page.getByLabel(/^Key/).fill("s4-orders-key");
        await page.getByLabel("Server address").press("Enter");
        // Back on the list, and done: it needs no account of the person's.
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "s4-orders").getByText("Reconnected").waitFor();
        expect(server.added).toEqual(["address:S4 Orders"]);
        await row(page, "gmail")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
      } finally {
        await page.close();
      }

      // Anybody else: the row says only an admin can, and who they are, with nothing to press.
      const member = new FakeServer([finishedMove([S4_ORDERS])]);
      const asMember = await open("/reconnect", member, engine);
      try {
        await row(asMember, "s4-orders")
          .getByText(
            "An admin has to turn S4 Orders on before you can connect it: Priya Raman (priya@example.com) or Ines Duarte (ines@example.com).",
          )
          .waitFor();
        expect(
          await row(asMember, "s4-orders")
            .getByRole("button", { name: "Reconnect" })
            .count(),
        ).toBe(0);
      } finally {
        await asMember.close();
      }
    }, 90_000);

  /*
   * Every kind of app is one press. Reconnect on an app of OpenBot's own catalogue that the
   * organization hasn't added asked the directory for it, which refused, and the row said "Couldn't
   * turn Google Drive on here." Now it is added from the catalogue, as the catalogue's own page adds
   * it, and its sign-in starts; one reached with a key opens its own page with the key form open, and
   * once saved comes back to the list, done.
   */
  for (const engine of engines)
    test(`an admin's Reconnect on an app of OpenBot's catalogue adds it from there, or opens its key form, in ${engine}`, async () => {
      const server = new FakeServer(
        [finishedMove([DRIVE, EXA, GMAIL])],
        "admin",
      );
      server.apps.catalogue = [DRIVE_ENTRY, EXA_ENTRY];
      const page = await open("/reconnect", server, engine);
      try {
        // Signed in to as each person: added from the catalogue, then straight to its sign-in.
        await row(page, "gdrive")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${SIGN_IN}/gdrive`);
        expect(server.added).toEqual(["catalogue:gdrive"]);
        expect(server.connects).toEqual([{ appId: "gdrive", key: false }]);

        // Reached with a key an admin gives: its own page, with that form open on arrival.
        await page.goto(`${ORIGIN}/reconnect`);
        await row(page, "exa")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL((url) => url.pathname === "/admin/plugins/exa");
        const form = page.getByRole("dialog", { name: "Access token for Exa" });
        await form.getByLabel("Access token").fill("exa-key");
        // Styled, so the dialog's backdrop sits behind its buttons as in the app.
        await style(page);
        await shoot(page, "catalogue-key", engine, "light", WIDE);
        await form.getByRole("button", { name: "Save" }).click();
        // Back on the list, and done: reached with the organization's key, nobody connects it.
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "exa").getByText("Reconnected").waitFor();
        expect(server.added).toEqual(["catalogue:gdrive", "catalogue:exa"]);
        expect(server.credentials).toEqual([credentialId(1)]);
        expect(await page.getByText(/Couldn't turn/).count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 90_000);

  /*
   * Found by the same run: once an admin added that server with the organization's key, the list
   * still offered Reconnect on it and home still counted it, because only the person's own
   * connections marked an app done. An app that needs no account of the person's (a server reached
   * with the organization's key, or a shared account that is connected) is done once it is here.
   */
  for (const engine of engines)
    test(`an app here that needs no account of the person's is done, on the list and at home, in ${engine}`, async () => {
      const server = new FakeServer([
        finishedMove([S4_ORDERS, NOTION, DOCS, GMAIL]),
      ]);
      server.apps.servers = [
        ...(server.apps.servers ?? []).filter(
          (app) => app.id !== "composio-notion",
        ),
        S4_ORDERS_HERE,
        NOTION_SHARED,
        ...SIGN_IN_APPS,
      ];
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "s4-orders").getByText("Reconnected").waitFor();
        await row(page, "notion").getByText("Reconnected").waitFor();
        // A server that signs each person in, and a person's own sign-in, still wait for them.
        for (const app of ["docs-search", "gmail"])
          await row(page, app)
            .getByRole("button", { name: "Reconnect" })
            .waitFor();
        await page.goto(`${ORIGIN}/`);
        const bar = page.getByRole("complementary", {
          name: "Apps to reconnect",
        });
        await bar.waitFor();
        expect(await bar.textContent()).toContain(
          "2 apps from your move still need reconnecting.",
        );
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an admin's Reconnect adds an app the organization hasn't yet, and says so when it can't, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([SLACK, LINEAR])], "admin");
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // Added from its directory entry, then its own page, with the way back, and the same press
        // starts its sign-in.
        await page.waitForURL(`${ORIGIN}/connections/composio-slack`);
        await page
          .getByRole("heading", {
            level: 1,
            name: "Slack",
            includeHidden: true,
          })
          .waitFor();
        const step = page.getByRole("dialog", { name: "Connecting Slack" });
        await step.waitFor();
        expect(server.connects).toEqual([
          { appId: "composio-slack", key: false },
        ]);
        // Not now: the step is cancelled, and the way back is there.
        // Escape, which is Cancel: unstyled until `style`, the step's backdrop covers its buttons.
        await page.keyboard.press("Escape");
        await step.waitFor({ state: "detached" });
        await page
          .getByRole("button", { name: "Your apps to reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        // The directory refuses Linear: back on the list, the row says so.
        await row(page, "linear")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await row(page, "linear")
          .getByText("Couldn't turn Linear on here. Try again in a moment.")
          .waitFor();
        expect(path(page)).toBe("/reconnect");
        await row(page, "linear")
          .getByRole("button", { name: "Try again" })
          .waitFor();
        expect(server.added).toEqual(["directory:slack", "directory:linear"]);
        // An admin adds it themselves, so is never told who the admins are.
        expect(await page.getByText(/northwind|example\.com\)/).count()).toBe(
          0,
        );
        expect(server.membersAsks).toBe(0);
        await shoot(page, "admin-refused", engine, "light", WIDE);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`apps open, a member's Reconnect adds an app the organization hasn't yet, as an admin's does, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([SLACK])]);
      server.lockedDown = false;
      const page = await open("/reconnect", server, engine);
      try {
        // Nothing waits for an admin: the row offers Reconnect, and names nobody.
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${ORIGIN}/connections/composio-slack`);
        await page.getByRole("dialog", { name: "Connecting Slack" }).waitFor();
        expect(server.added).toEqual(["directory:slack"]);
        expect(server.connects).toEqual([
          { appId: "composio-slack", key: false },
        ]);
        expect(server.membersAsks).toBe(0);
      } finally {
        await page.close();
      }
    }, 90_000);

  /*
   * Reported on 1.2.0-rc.3, on OpenBot Cloud after a move: Reconnect opened the app's page, where
   * Connect had to be pressed again. One press of Reconnect is the whole connect now, for every kind
   * of app: the sign-in, or the key form, with no Connect pressed in between.
   */
  for (const engine of engines)
    test(`one Reconnect on a sign-in app goes straight to its sign-in, and back to the list once connected, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([GMAIL, CALENDAR])]);
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "gmail")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // OpenBot's step before a sign-in through Composio, which goes on by itself.
        const step = page.getByRole("dialog", { name: "Connecting Gmail" });
        await step.waitFor();
        expect(server.connects).toEqual([
          { appId: "composio-gmail", key: false },
        ]);
        await shoot(page, "press-sign-in", engine, "light", WIDE);
        await page.waitForURL(`${SIGN_IN}/composio-gmail`, {
          timeout: 15_000,
        });
        // Google's sign-in connects it and comes back to Gmail's page, which goes back to the list.
        server.connected.add("composio-gmail");
        await page.goto(
          `${ORIGIN}/connections/composio-gmail?status=success&connected_account_id=ca_1`,
        );
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "gmail").getByText("Reconnected").waitFor();
        // Coming back started nothing again.
        expect(server.connects).toEqual([
          { appId: "composio-gmail", key: false },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`one Reconnect on a key app opens its key form, and saving the key comes back to the list, in ${engine}`, async () => {
      const server = new FakeServer([
        finishedMove([FIREFLIES, POSTHOG, GMAIL]),
      ]);
      server.apps.servers = [...(server.apps.servers ?? []), ...KEY_APPS];
      server.keyApps = new Set(["composio-fireflies", "composio-posthog"]);
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "fireflies")
          .getByRole("button", { name: "Reconnect" })
          .click();
        const form = page.getByRole("dialog", { name: "Connect your account" });
        await form.getByLabel("API key").waitFor();
        expect(path(page)).toBe("/connections/composio-fireflies");
        await shoot(page, "press-key", engine, "light", WIDE);
        await form.getByLabel("API key").fill(GOOD_KEY);
        // Enter sends the form: unstyled until `style`, the dialog's backdrop covers its buttons.
        await form.getByLabel("API key").press("Enter");
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "fireflies").getByText("Reconnected").waitFor();

        // PostHog's listing can't say how it connects. It takes a key, so the press opens the form.
        await row(page, "posthog")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await form.getByLabel("API key").waitFor();
        expect(path(page)).toBe("/connections/composio-posthog");
        expect(await page.getByRole("alert").count()).toBe(0);
        await form.getByLabel("API key").fill(GOOD_KEY);
        await form.getByLabel("API key").press("Enter");
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "posthog").getByText("Reconnected").waitFor();
        expect(server.connects).toEqual([
          { appId: "composio-fireflies", key: false },
          { appId: "composio-fireflies", key: true },
          { appId: "composio-posthog", key: false },
          { appId: "composio-posthog", key: false },
          { appId: "composio-posthog", key: true },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`one Reconnect on an app added by its address, or a built-in one, goes straight to its sign-in, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([DOCS, DRIVE, GMAIL])]);
      server.apps.servers = [...(server.apps.servers ?? []), ...SIGN_IN_APPS];
      server.apps.catalogue = [DRIVE_ENTRY];
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "docs-search")
          .getByRole("button", { name: "Reconnect" })
          .click();
        // OpenBot signs in to it itself: no step, straight to the sign-in.
        await page.waitForURL(`${SIGN_IN}/docs-search`);
        expect(server.connects).toEqual([{ appId: "docs-search", key: false }]);
        server.connected.add("docs-search");
        await page.goto(`${ORIGIN}/connections?connected=docs-search`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "docs-search").getByText("Reconnected").waitFor();

        await row(page, "gdrive")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${SIGN_IN}/gdrive`);
        expect(server.connects).toEqual([
          { appId: "docs-search", key: false },
          { appId: "gdrive", key: false },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  /*
   * FOUND IN DOGFOODING (OpenBot Desktop 1.2.0 on OpenBot Cloud): Fireflies moved as its key app,
   * and here it had been added as its sign-in, Fireflies' own server. Reconnect never found it, so
   * it added Fireflies again; the add was refused as already added three times, and the press never
   * reached the sign-in. While it looked, the list was a blank page for seconds.
   */
  for (const engine of engines)
    test(`one Reconnect on a key app added here as its sign-in starts that sign-in, and the list stays while it looks, in ${engine}`, async () => {
      const vendorServer = (id: string) => ({
        id,
        title: "Fireflies.ai",
        provenance: "custom",
        url: "https://api.fireflies.ai/mcp",
        signIn: true,
      });
      const server = new FakeServer(
        [finishedMove([FIREFLIES, GMAIL])],
        "admin",
      );
      server.apps.servers = [
        ...(server.apps.servers ?? []),
        vendorServer("fireflies-mcp"),
      ];
      const page = await open("/reconnect", server, engine);
      try {
        // The server's own id for it: found here, so nothing is added again.
        await row(page, "fireflies")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.waitForURL(`${SIGN_IN}/fireflies-mcp`);
        expect(server.added).toEqual([]);
        expect(server.connects).toEqual([
          { appId: "fireflies-mcp", key: false },
        ]);
        server.connected.add("fireflies-mcp");
        await page.goto(`${ORIGIN}/connections?connected=fireflies-mcp`);
        await page.waitForURL(`${ORIGIN}/reconnect`);
        await row(page, "fireflies").getByText("Reconnected").waitFor();
      } finally {
        await page.close();
      }

      // Under an id nothing can tell from its name: the add answers that it is already here.
      const again = new FakeServer([finishedMove([FIREFLIES, GMAIL])], "admin");
      again.apps.servers = [
        ...(again.apps.servers ?? []),
        vendorServer("fireflies-mcp-2"),
      ];
      again.apps.directory = [
        ...(again.apps.directory ?? []),
        {
          slug: "fireflies",
          name: "Fireflies",
          connection: { kind: "self-registering" },
        },
      ];
      let release: () => void = () => {};
      const second = await open("/reconnect", again, engine);
      try {
        const reconnect = row(second, "fireflies").getByRole("button", {
          name: "Reconnect",
        });
        await reconnect.waitFor();
        again.directoryHeld = new Promise((resolve) => {
          release = resolve;
        });
        await reconnect.click();
        // Looking it up: the list stays, and the row says it is under way.
        await row(second, "fireflies")
          .getByRole("button", { name: "Connecting…" })
          .waitFor();
        await heading(second, "Reconnect your apps");
        await row(second, "gmail")
          .getByRole("button", { name: "Reconnect" })
          .waitFor();
        expect(await measured(second)).toEqual(FINE);
        await shoot(second, "reconnect-working", engine, "light", WIDE);
        release();
        await second.waitForURL(`${SIGN_IN}/fireflies-mcp-2`, {
          timeout: 15_000,
        });
        expect(again.added).toEqual(["directory:fireflies"]);
        expect(again.connects).toEqual([
          { appId: "fireflies-mcp-2", key: false },
        ]);
      } finally {
        await second.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an admin's one Reconnect turns on an app the organization hasn't, then starts its sign-in, in ${engine}`, async () => {
      const server = new FakeServer([finishedMove([SLACK, GMAIL])], "admin");
      const page = await open("/reconnect", server, engine);
      try {
        await row(page, "slack")
          .getByRole("button", { name: "Reconnect" })
          .click();
        await page.getByRole("dialog", { name: "Connecting Slack" }).waitFor();
        expect(server.added).toEqual(["directory:slack"]);
        await page.waitForURL(`${SIGN_IN}/composio-slack`, {
          timeout: 15_000,
        });
        expect(server.connects).toEqual([
          { appId: "composio-slack", key: false },
        ]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an OpenBot that takes no moves shows none of it, in ${engine}`, async () => {
      const server = new FakeServer(null);
      const page = await open("/connections", server, engine);
      try {
        await page.locator('[data-testid="account-composio-gmail"]').waitFor();
        await page.waitForTimeout(500);
        expect(await page.locator("[data-moved-apps-notice]").count()).toBe(0);
        expect(await page.getByRole("alert").allTextContents()).toEqual([]);
        await page.goto(`${ORIGIN}/reconnect`);
        await page.waitForURL(`${ORIGIN}/`);
        await page.waitForTimeout(500);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        expect(await page.getByRole("alert").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  /*
   * Found by the server's personal-edition journey on the 1.2.0-rc.2 candidate: every page of a
   * self-hosted OpenBot or the personal edition asked for the person's moves, which only OpenBot
   * Cloud takes, and each answer was a 404 in the network panel. Nothing showed, but every page
   * made a failing request. An OpenBot that isn't hosted is never asked.
   */
  for (const engine of engines)
    test(`an OpenBot that isn't OpenBot Cloud is never asked for moves, on any page, in ${engine}`, async () => {
      const server = new FakeServer(null, "member", false);
      const page = await open("/", server, engine);
      try {
        // Home, drawn in the frame that carries the reconnect bar, with every read it made answered.
        await page.waitForLoadState("networkidle");
        expect(server.importAsks).toBe(0);
        await page.goto(`${ORIGIN}/connections`);
        await page.locator('[data-testid="account-composio-gmail"]').waitFor();
        await page.goto(`${ORIGIN}/reconnect`);
        await page.waitForURL(`${ORIGIN}/`);
        await page.waitForTimeout(500);
        expect(server.importAsks).toBe(0);
        expect(
          server.failed.filter((line) => line.endsWith("/imports")),
        ).toEqual([]);
        expect(
          await page
            .getByRole("complementary", { name: "Apps to reconnect" })
            .count(),
        ).toBe(0);
        expect(await page.locator("[data-moved-apps-notice]").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    for (const theme of ["light", "dark"] as const)
      for (const window of [WIDE, PHONE])
        test(`the screens fit and look like the app, ${theme} at ${window.width}, in ${engine}`, async () => {
          const server = new FakeServer([
            finishedMove([GMAIL, CALENDAR, SLACK]),
          ]);
          const page = await open("/reconnect", server, engine, theme, window);
          try {
            await row(page, "slack").waitFor();
            await page.waitForTimeout(300);
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "list", engine, theme, window);
            server.connected.add("composio-gmail");
            await page.reload();
            await row(page, "gmail").getByText("Reconnected").waitFor();
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "list-one-done", engine, theme, window);
            await page.goto(`${ORIGIN}/connections`);
            await page.locator("[data-moved-apps-notice]").waitFor();
            await page
              .locator('[data-testid="account-composio-notion"]')
              .waitFor();
            expect(await measured(page)).toEqual(FINE);
            await shoot(page, "connections", engine, theme, window);
            // Beside it, Connections as it was: nothing moved here.
            server.imports = null;
            await page.reload();
            await page
              .locator('[data-testid="account-composio-notion"]')
              .waitFor();
            await page.waitForTimeout(300);
            await shoot(page, "connections-before", engine, theme, window);
          } finally {
            await page.close();
          }
        }, 90_000);
});
