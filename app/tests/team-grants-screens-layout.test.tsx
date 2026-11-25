import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import type { Bot, Team } from "@/lib/api/generated/model";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  DEPLOYMENT_PATH,
  deploymentResponse,
  overviewResponse,
  PREVIEW_CAPABILITIES_PATH,
  REPLAY_NETWORK_POLICY_PATH,
  type TodayOverview,
  TRANSLATE_CAPABILITIES_PATH,
} from "./admin-settings-api";
import { type AppsFixture, answerAppsApi, appPath } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { answerBotsList, botPath } from "./bots-api";
import {
  connectionPage,
  MY_CONNECTIONS_PATH,
  sharedConnectionPath,
  sharedConnectionResponse,
} from "./connections-api";
import { SKILLS_PATH, skillPath, skillsResponse } from "./skills-api";

/**
 * The Admin screens where a rule or a grant names a team hold their layout, wide and on a phone, in
 * light and dark.
 *
 * Permissions and its overrides, Describe who can do what, a network policy on Computers, "Runs as"
 * on What would happen, a shared account's audience, and the Teams row on an app's page and on a
 * skill's page are drawn in a real browser, in Admin's real frame, because whether a long team name
 * gives way, a dialog fits a phone or a menu stays inside the window is the browser's layout to
 * decide. Each is checked at 1440 and at 390: the page never scrolls sideways, every control is
 * whole inside the window, a row's actions never sit on top of its words, a dialog and a menu stay
 * inside the window, nothing says it couldn't load, and no team is called by its id.
 *
 * The server's answers are served as routes at the API's addresses: an organization with four
 * teams, one with a long name, one from the company's directory and one under another, with a rule
 * for a directory group from before there were teams and one for a team deleted since.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/team-grants-screens-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each screen is saved as <screen>-<engine>-<theme>-<width>.png.
 *
 * OPENBOT_APP_BEFORE=1 draws the same pages as they were when a rule named a directory group, for a
 * checkout from before teams, to look at beside these: the answers name groups, and each screen is
 * reached by the words it had then.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const before = process.env.OPENBOT_APP_BEFORE === "1";
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

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

const team = (id: string, name: string, rest: Partial<Team> = {}): Team => ({
  id,
  name,
  description: null,
  parentTeamId: null,
  source: "openbot",
  memberCount: 0,
  role: null,
  canManage: true,
  canMove: true,
  canDelete: true,
  createdAt: "2026-11-15T09:12:40.000Z",
  ...rest,
});

const SALES = team("team_7f3a9c", "Sales", { memberCount: 14 });
const EMEA = team("team_2c81e4", "Sales EMEA", {
  parentTeamId: SALES.id,
  memberCount: 5,
});
// A long name, which is what a row, a chip and a tickbox's label have to give way to.
const SUCCESS = team(
  "team_9e52aa",
  "Customer Success and Renewals, North America",
  { memberCount: 23 },
);
const FINANCE = team("team_4b1d07", "Finance", {
  source: "directory",
  memberCount: 12,
  canManage: false,
  canMove: false,
  canDelete: false,
});
const TEAMS = before ? [] : [SALES, EMEA, SUCCESS, FINANCE];
/** A team a rule still names, deleted since. */
const GONE = "team_0d6f1b";
/** A directory group, which rules named before there were teams. */
const GROUP = "contractors";

const DEFAULT_DESTINATIONS = [
  "github.com",
  "githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "pypi.org",
];

const policy = (
  scopeKind: "organization" | "group" | "team",
  scopeId: string,
  mode: string,
  hosts: string[],
) => ({
  scopeKind,
  scopeId,
  mode,
  rules: hosts.map((value) => ({ type: "domain", value })),
  locked: false,
  updatedBy: "dana.whitfield@northwind.example",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

/** The organization's settings, switches and network policies, as Admin reads them. */
const OVERVIEW: TodayOverview = {
  groups: [GROUP, "field-sales"],
  defaultDestinations: DEFAULT_DESTINATIONS,
  capabilities: [
    {
      capability: "cloudBrowser",
      title: "Cloud browser",
      description: "Bots may browse the web on a computer of their own.",
      default: true,
      organization: false,
      roles: {},
      groups: { [GROUP]: true },
      ...(before ? {} : { teams: { [SALES.id]: true, [GONE]: true } }),
    },
    {
      capability: "localComputer",
      title: "Their own computer",
      description: "Bots may use folders on the person's computer.",
      default: true,
      organization: null,
      roles: { member: false },
      groups: {},
      ...(before ? {} : { teams: {} }),
    },
  ],
  network: [
    policy("organization", "", "defaults_plus_allowlist", [
      "hubspot.com",
      "salesforce.com",
    ]),
    ...(before
      ? []
      : [
          policy("team", SUCCESS.id, "allowlist_only", [
            "zendesk.com",
            "gainsight.com",
            "salesforce.com",
          ]),
        ]),
    policy("group", GROUP, "defaults_plus_allowlist", ["hubspot.com"]),
    ...(before
      ? []
      : [policy("team", GONE, "defaults_plus_allowlist", ["example.com"])]),
  ],
};

/** The one change the model writes on Describe who can do what, and who it changes. */
const CHANGE = before
  ? { scopeKind: "group", scopeId: GROUP }
  : { scopeKind: "team", scopeId: SALES.id };
const TRANSLATION = {
  changes: [{ ...CHANGE, capability: "cloudBrowser", allowed: true }],
  summary: "One group of people gets the cloud browser.",
  explanation: before
    ? "Grants Cloud browser to the group contractors. Everybody else keeps the organization's switch, which is off."
    : "Grants Cloud browser to the team Sales. Everybody else keeps the organization's switch, which is off.",
  check: { ok: true },
  warning: null,
};
const PREVIEW = {
  check: { ok: true },
  people: [
    {
      id: "sam",
      email: "sam.ortiz@northwind.example",
      name: "Sam Ortiz",
      role: "member",
      groups: before ? [GROUP] : [],
      capabilities: [
        {
          capability: "cloudBrowser",
          title: "Cloud browser",
          before: { allowed: false, decidedBy: "organization", scopeId: "" },
          after: {
            allowed: true,
            decidedBy: CHANGE.scopeKind,
            scopeId: CHANGE.scopeId,
          },
        },
      ],
    },
  ],
  counts: { people: 5, losing: 0, gaining: 1, keeping: 0, unchanged: 4 },
  activity: { days: 30, unmapped: [] },
  warning: null,
};

const bot = (id: string, name: string, title: string): Bot => ({
  id,
  name,
  title,
  roleDescription: "",
  avatarSeed: id,
  visibility: "private",
  hidden: false,
  pinned: false,
  systemOwned: false,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  canManage: true,
  mine: true,
  assignedToMe: false,
  builtIn: true,
  runsOnOpenBotModel: true,
  keyFromOpenBot: true,
  isolationActive: false,
  isolationOffReason: null,
});
const BOTS = [
  bot("helpdesk", "Helpdesk", "Answers support tickets"),
  bot("expenses", "Expenses", "Files receipts"),
  bot("research", "Research", "Reads the market"),
];

/** The apps added here: one with a shared account, and one each person connects for themselves. */
const APPS: AppsFixture = {
  catalogue: [{ key: "notion", title: "Notion", auth: "user-oauth" }],
  servers: [
    {
      id: "gh",
      title: "GitHub",
      vendor: "GitHub",
      url: "https://mcp.github.test/mcp",
      summary: "Issues and pull requests.",
      docsUrl: "",
      provenance: "first-party",
      hasCredential: true,
      toolsRefreshedAt: null,
      lastError: null,
      addedBy: "dana",
      dynamicClient: false,
      authScheme: null,
      accountMode: "shared",
      sharedVendorConnected: true,
      ownerGrants: "any",
      ownerGrantsChosen: null,
      withdrawn: [],
      tools: [
        {
          name: "create_issue",
          description: "Open an issue.",
          effect: "write",
          grantedTo: [],
        },
        {
          name: "list_issues",
          description: "List the issues of a repository.",
          effect: "read",
          grantedTo: [],
        },
      ],
    },
    {
      id: "notion",
      title: "Notion",
      summary: "Pages and databases.",
      provenance: "first-party",
      hasCredential: true,
      dynamicClient: true,
      tools: [
        {
          name: "search_pages",
          description: "Search the pages of a workspace.",
          effect: "read",
          grantedTo: ["helpdesk", "research"],
        },
        {
          name: "create_page",
          description: "Write a new page.",
          effect: "write",
          grantedTo: ["research"],
        },
      ],
    },
  ],
  botsMayCallBack: true,
  redirectUri: "https://openbot.example/callback",
  composioConfigured: true,
  provider: "composio",
  authorizesPerAction: false,
};

/** Who Helpdesk's audience names today, which the shared account's dialog starts from. */
const NEEDED = {
  audience: "people",
  outsideInput: false,
  members: before
    ? [
        { kind: "group", value: "platform" },
        { kind: "user", value: "sam" },
      ]
    : [
        { kind: "team", value: SALES.id },
        { kind: "team", value: SUCCESS.id },
        { kind: "group", value: "platform" },
        { kind: "team", value: GONE },
      ],
};

/** The action What would happen starts from, handed over in the address as Audit hands it over. */
const ACTION = {
  bot: "sales",
  person: "sam",
  group: "",
  initiator: "routine",
  surface: "app",
  app: "gmail",
  tool: "send_email",
  intent: "",
  host: "",
  label: "",
  command: "",
  file: "",
};
const VOCABULARY = {
  bots: [
    { id: "research", name: "Research", owner: "priya" },
    { id: "sales", name: "Sales", owner: "sam" },
  ],
  people: [
    {
      id: "dana",
      name: "Dana Whitfield",
      email: "dana.whitfield@northwind.example",
    },
    { id: "priya", name: "Priya Nair", email: "priya.nair@northwind.example" },
    { id: "sam", name: "Sam Ortiz", email: "sam.ortiz@northwind.example" },
  ],
  groups: [GROUP, "field-sales"],
  ...(before ? {} : { teams: TEAMS.map(({ id, name }) => ({ id, name })) }),
  apps: [
    {
      id: "gmail",
      name: "Gmail",
      tools: [
        { name: "list_emails", effect: "read", destructive: false },
        { name: "send_email", effect: "write", destructive: false },
      ],
    },
  ],
};
const WHAT_IF = `/admin/what-if?action=${encodeURIComponent(
  JSON.stringify(JSON.stringify(ACTION)),
)}`;

const json = (body: unknown) => Response.json(body);

/** What the API answers for one request, or undefined for an address these screens never ask. */
function answer(method: string, url: URL): Response | undefined {
  const path = url.pathname;
  if (method === "POST") {
    if (path === TRANSLATE_CAPABILITIES_PATH) return json(TRANSLATION);
    if (path === PREVIEW_CAPABILITIES_PATH) return json(PREVIEW);
    if (path === REPLAY_NETWORK_POLICY_PATH)
      return json({
        scanned: 0,
        covered: 0,
        wouldBlock: 0,
        wouldAllow: 0,
        undecided: 0,
        unchanged: 0,
        hosts: [],
        sites: 0,
      });
    return undefined;
  }
  if (method !== "GET") return undefined;
  // The organization's apps switch, which a skill's tool list reads: open, the default.
  if (path === "/api/v2/organizations/default/settings/apps")
    return json({ lockedDown: false });
  // Managed updates don't apply to this OpenBot, so Admin doesn't list them.
  if (path === "/api/v2/organizations/default/management")
    return Response.json(
      {
        type: "https://open.bot/errors/management-unavailable",
        title: "Managed updates aren't available here.",
        status: 404,
        detail: "Managed updates aren't available for this OpenBot.",
        code: "MANAGEMENT_UNAVAILABLE",
        category: "not_found",
        retryable: false,
        requestId: "req_test",
        traceId: "trace_test",
      },
      { status: 404 },
    );
  if (path === DEPLOYMENT_PATH)
    return deploymentResponse({
      edition: "team",
      generativeUi: true,
      builtInBots: true,
      isolatedBots: true,
    });
  if (path === ME_PATH)
    return meResponse({
      user: {
        id: "dana",
        name: "Dana Whitfield",
        email: "dana.whitfield@northwind.example",
        role: "admin",
      },
      version: "v1.0.4",
    });
  if (path === `${ORGANIZATION}/teams`)
    return json({ teams: TEAMS, canCreate: true, nextCursor: null });
  if (path === `${ORGANIZATION}/what-if/vocabulary`) return json(VOCABULARY);
  if (path === `${ORGANIZATION}/computers`)
    return json({
      computers: [
        {
          computer: "person:sam",
          kind: "person",
          personId: "sam",
          person: { name: "Sam Ortiz", email: "sam.ortiz@northwind.example" },
          running: true,
          startedAt: "2026-11-15T08:02:11.000Z",
          egress: null,
        },
        {
          computer: "person:priya",
          kind: "person",
          personId: "priya",
          person: { name: "Priya Nair", email: "priya.nair@northwind.example" },
          running: false,
          startedAt: null,
          egress: null,
        },
      ],
      isolation: "per-person",
      nextCursor: null,
    });
  if (path === `${ME_PATH}/host-access`)
    return json({ connected: false, desktop: false, grants: [], pending: [] });
  if (path === `${botPath("helpdesk")}/shared-use`)
    return json({
      apps: [
        {
          serverId: "gh",
          title: "GitHub",
          approval: null,
          needed: NEEDED,
          covered: false,
        },
      ],
      pending: [],
    });
  if (/\/bots\/[^/]+\/shared-use$/.test(path))
    return json({ apps: [], pending: [] });
  if (path === `${appPath("notion")}/team-grants`)
    return json({ teams: [SALES.id, SUCCESS.id, GONE] });
  if (path === `${skillPath("triage")}/team-grants`)
    return json({ teams: [SUCCESS.id, FINANCE.id] });
  if (path === sharedConnectionPath("notion"))
    return sharedConnectionResponse({ appId: "notion", connected: false });
  if (path === sharedConnectionPath("gh"))
    return sharedConnectionResponse({
      appId: "gh",
      connected: true,
      connectedBy: "dana",
      displayName: "northwind-bot",
    });
  if (path === MY_CONNECTIONS_PATH) return connectionPage([]);
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  if (path === SKILLS_PATH)
    return skillsResponse([
      {
        slug: "triage",
        title: "Triage the inbox",
        summary: "Sorts new mail by what needs an answer",
        grantedTo: ["helpdesk"],
      },
    ]);
  return (
    overviewResponse(path, OVERVIEW) ??
    answerBotsList(url.href, { method }, { visible: BOTS, hidden: [] }) ??
    answerAppsApi(url.href, { method }, APPS)
  );
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "team-grants-screens.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
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

/**
 * One thing a person does on the way to a screen, ending on what shows it has happened. The page
 * is styled again after each, so the next is done on the page as a person sees it: a control in a
 * dialog with no styles can't be clicked.
 */
type Step = (page: Page) => Promise<unknown>;

/** One screen: where it is, and what a person does to reach the state to be looked at. */
type Screen = {
  name: string;
  path: string;
  /** Not there before teams: the Teams row's dialog. */
  teamsOnly?: boolean;
  /** The first step waits for the page itself. */
  steps: Step[];
  /** Where to look, once the screen is styled: a part of the page further down. */
  lookAt?: (page: Page) => Promise<unknown>;
};

/** Scrolls a section's heading to the top of the page's own scroller. */
const lookAtHeading = (name: string) => (page: Page) =>
  page
    .getByRole("heading", { name, exact: true })
    .evaluate((heading) => heading.scrollIntoView({ block: "start" }));

const overridesRow = (page: Page) =>
  page.getByRole("button", {
    name: before ? /Role and group overrides/ : /Role and team overrides/,
  });
const scopeBox = (page: Page) =>
  page.getByRole("dialog").getByRole("combobox", { name: "Scope" });
const scopeOption = (page: Page) =>
  page.getByRole("option", {
    name: before ? `Group: ${GROUP}` : `Team: ${SALES.name}`,
    exact: true,
  });

/** Permissions, its overrides dialog, and the dialog's list of scopes. */
const OVERRIDES_SCOPES: Step[] = [
  (page) => overridesRow(page).waitFor(),
  async (page) => {
    await overridesRow(page).click();
    await scopeBox(page).waitFor();
  },
  async (page) => {
    await scopeBox(page).click();
    await scopeOption(page).waitFor();
  },
];

const runsAs = (page: Page) => page.locator('[data-what-if-chip="person"]');

/** What would happen, with the "Runs as" chip's menu open. */
const RUNS_AS_MENU: Step[] = [
  (page) => runsAs(page).getByText("Sam Ortiz").waitFor(),
  async (page) => {
    await runsAs(page).getByRole("button").click();
    await page
      .getByText(before ? "Anyone in a group" : "Anyone in a directory group")
      .waitFor();
  },
];

const groupPolicyRow = (page: Page) =>
  page.getByRole("button", { name: new RegExp(`^Group: ${GROUP}`) });
const teamsRow = (page: Page) => page.getByRole("button", { name: /^Teams/ });
const sharedSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Let Helpdesk call create_issue" });

const SCREENS: Screen[] = [
  {
    name: "permissions",
    path: "/admin/permissions",
    steps: [(page) => overridesRow(page).waitFor()],
  },
  {
    name: "permissions-scope-list",
    path: "/admin/permissions",
    steps: OVERRIDES_SCOPES,
  },
  {
    name: "permissions-overrides",
    path: "/admin/permissions",
    steps: [
      ...OVERRIDES_SCOPES,
      async (page) => {
        await scopeOption(page).click();
        await page
          .getByRole("dialog")
          .getByText(before ? "A group can only add." : "A team can only add.")
          .waitFor();
      },
    ],
  },
  {
    name: "permissions-describe",
    path: "/admin/permissions/describe",
    steps: [
      (page) => page.getByLabel("Describe the change").waitFor(),
      async (page) => {
        await page
          .getByLabel("Describe the change")
          .fill(
            before
              ? "Contractors can use the cloud browser"
              : "People in Sales can use the cloud browser",
          );
        await page.getByRole("button", { name: "Write changes" }).click();
        await page.getByText("Gains access", { exact: true }).waitFor();
      },
    ],
    // The changes and who they change, under the sentence and its reading.
    lookAt: (page) =>
      page
        .getByText("Changes", { exact: true })
        .evaluate((label) => label.scrollIntoView({ block: "start" })),
  },
  {
    name: "computers-network",
    path: "/admin/computers",
    steps: [(page) => groupPolicyRow(page).waitFor()],
    lookAt: lookAtHeading("Network"),
  },
  {
    name: "computers-add-policy",
    path: "/admin/computers",
    steps: [
      (page) => groupPolicyRow(page).waitFor(),
      async (page) => {
        await page
          .getByRole("button", {
            name: before ? "Add a group policy" : "Add a team policy",
          })
          .click();
        await page
          .getByRole("dialog")
          .getByRole("combobox", { name: before ? "Group" : "Team" })
          .waitFor();
      },
    ],
  },
  {
    name: "computers-group-policy",
    path: "/admin/computers",
    steps: [
      (page) => groupPolicyRow(page).waitFor(),
      async (page) => {
        await groupPolicyRow(page).click();
        await page
          .getByRole("dialog", { name: "Group network policy" })
          .getByLabel("Allowlist", { exact: true })
          .waitFor();
      },
    ],
  },
  {
    name: "what-if-runs-as",
    path: WHAT_IF,
    steps: RUNS_AS_MENU,
  },
  {
    name: "what-if-chips",
    path: WHAT_IF,
    steps: [
      ...RUNS_AS_MENU,
      async (page) => {
        await page
          .getByRole("menuitemradio", { name: before ? GROUP : SUCCESS.name })
          .click();
        await runsAs(page)
          .getByText(`Anyone in ${before ? GROUP : SUCCESS.name}`)
          .waitFor();
        // The menu stays open after a choice. Closed, the chips are what is looked at.
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "detached" });
      },
    ],
  },
  {
    name: "shared-account",
    path: "/admin/plugins/gh/bots/helpdesk",
    steps: [
      (page) => sharedSwitch(page).waitFor({ state: "attached" }),
      async (page) => {
        await sharedSwitch(page).click();
        const dialog = page.getByRole("dialog");
        await dialog
          .getByText("Let Helpdesk use the shared GitHub account?")
          .waitFor();
        await (before
          ? dialog.getByRole("radio", { name: /^Named/ })
          : dialog.getByRole("checkbox", { name: SUCCESS.name })
        ).waitFor();
      },
    ],
  },
  {
    name: "app-page",
    path: "/admin/plugins/notion",
    steps: [
      (page) =>
        before
          ? page.getByRole("heading", { level: 1, name: "Notion" }).waitFor()
          : teamsRow(page).waitFor(),
    ],
  },
  {
    name: "app-teams",
    path: "/admin/plugins/notion",
    teamsOnly: true,
    steps: [
      (page) => teamsRow(page).waitFor(),
      async (page) => {
        await teamsRow(page).click();
        await page
          .getByRole("dialog", { name: "Teams that can use Notion" })
          .getByRole("checkbox", { name: "A team that no longer exists" })
          .waitFor();
      },
    ],
  },
  {
    name: "skill-page",
    path: "/admin/skills/triage",
    steps: [
      (page) =>
        before
          ? page.getByRole("heading", { name: "Manage" }).waitFor()
          : teamsRow(page).waitFor(),
    ],
    lookAt: lookAtHeading("Manage"),
  },
  {
    name: "skill-teams",
    path: "/admin/skills/triage",
    teamsOnly: true,
    steps: [
      (page) => teamsRow(page).waitFor(),
      async (page) => {
        await teamsRow(page).click();
        await page
          .getByRole("dialog", { name: "Teams that can use Triage the inbox" })
          .getByRole("checkbox", { name: SUCCESS.name })
          .waitFor();
      },
    ],
  },
];

/** Each stylesheet built so far, by the classes it was built for. */
const css = new Map<string, string>();

/** Styles the page for the classes on it now, as the app's build styles it. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  const key = [...new Set(classes)].sort().join(" ");
  let sheet = css.get(key);
  if (!sheet) {
    sheet = await stylesheet(key.split(" "));
    css.set(key, sheet);
  }
  await page.evaluate((content) => {
    const tag =
      document.getElementById("app-styles") ??
      document.head.appendChild(document.createElement("style"));
    tag.id = "app-styles";
    tag.textContent = content;
  }, sheet);
}

async function open(
  screen: Screen,
  engine: string,
  theme: Theme,
  window: Window,
): Promise<{ page: Page; unanswered: string[] }> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  /** Each request to the API these routes had no answer for: a screen that would say it failed. */
  const unanswered: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      const response = answer(request.method(), url);
      if (!response) unanswered.push(`${request.method()} ${path}`);
      return response
        ? route.fulfill({
            status: response.status,
            contentType:
              response.headers.get("content-type") ?? "application/json",
            body: await response.text(),
          })
        : route.fulfill({ status: 404, json: { detail: "Not found." } });
    }
    // Every other address is the app's own page, as its server answers it.
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${screen.path}`);
  for (const step of screen.steps) {
    await step(page);
    await style(page);
  }
  await page.evaluate(() => document.fonts.ready);
  await screen.lookAt?.(page);
  // Rows ease in and a dialog scales up: looked at once they are still.
  await page.waitForTimeout(400);
  return { page, unanswered };
}

/**
 * What a person would see wrong: sideways scroll, a control cut off, words under a button, a dialog
 * or a menu off the window, a line saying something couldn't load, a team called by its id.
 */
async function measured(page: Page) {
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const whole = (rect: DOMRect) =>
      inside(rect) && rect.top >= 0 && rect.bottom <= innerHeight + 0.5;
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        // Inside the window top to bottom, or it is simply further down the page.
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const dialog = document.querySelector("[data-slot=dialog-content]");
    // With a dialog open the page behind it is not what is being used.
    const scope: Element = dialog ?? document.body;
    const controls = [
      ...scope.querySelectorAll(
        "button, a, input, textarea, [role=combobox], [role=checkbox], [role=switch]",
      ),
    ].filter(shown);
    const cut = controls
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map((control) => control.textContent?.trim() || control.tagName);
    const overlapping: string[] = [];
    const squeezed: string[] = [];
    for (const row of scope.querySelectorAll("[data-slot=item]")) {
      if (!shown(row)) continue;
      const title = row.querySelector("[data-slot=item-title]");
      const actions = row.querySelector("[data-slot=item-actions]");
      const name = title?.textContent?.trim() ?? "";
      // The words' column, which the actions beside it must leave room to read in.
      const column = row.querySelector("[data-slot=item-content]");
      if (column && column.getBoundingClientRect().width < 120)
        squeezed.push(name);
      if (!title || !actions) continue;
      const words = title.getBoundingClientRect();
      const buttons = actions.getBoundingClientRect();
      const apart =
        words.right <= buttons.left + 0.5 ||
        buttons.right <= words.left + 0.5 ||
        words.bottom <= buttons.top + 0.5 ||
        buttons.bottom <= words.top + 0.5;
      if (!apart) overlapping.push(name);
      // A row's actions stay inside the card that holds the row.
      const card = row.getBoundingClientRect();
      if (buttons.right > card.right + 0.5 || buttons.left < card.left - 0.5)
        overlapping.push(`${name} (outside its row)`);
    }
    const box = dialog?.getBoundingClientRect();
    const popups = [
      ...document.querySelectorAll("[role=menu], [role=listbox]"),
    ].filter(shown);
    return {
      sideways:
        document.documentElement.scrollWidth > innerWidth ||
        document.body.scrollWidth > innerWidth,
      cut,
      overlapping,
      squeezed,
      dialogInside: box ? whole(box) : true,
      popupInside: popups.every((popup) =>
        whole(popup.getBoundingClientRect()),
      ),
      alerts: [...document.querySelectorAll("[role=alert]")]
        .filter(shown)
        .map((alert) => alert.textContent?.trim() ?? ""),
      teamIds: document.body.innerText.match(/team_[0-9a-f]{6}/g) ?? [],
    };
  });
}

describe.skipIf(!asked)(
  "the screens where a rule or a grant names a team",
  () => {
    for (const screen of SCREENS) {
      if (before && screen.teamsOnly) continue;
      for (const engine of engines)
        for (const theme of THEMES)
          for (const window of [WIDE, PHONE]) {
            test(`${screen.name} holds its layout in ${engine}, ${theme}, ${window.width}px`, async () => {
              const { page, unanswered } = await open(
                screen,
                engine,
                theme,
                window,
              );
              try {
                if (shots) {
                  mkdirSync(shots, { recursive: true });
                  await page.screenshot({
                    path: join(
                      shots,
                      `${screen.name}-${engine}-${theme}-${window.width}.png`,
                    ),
                  });
                }
                expect({ ...(await measured(page)), unanswered }).toEqual({
                  sideways: false,
                  cut: [],
                  overlapping: [],
                  squeezed: [],
                  dialogInside: true,
                  popupInside: true,
                  alerts: [],
                  teamIds: [],
                  unanswered: [],
                });
              } finally {
                await page.close();
              }
            }, 60_000);
          }
    }
  },
);
