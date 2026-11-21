import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import type {
  OrganizationMember,
  Team,
  TeamBot,
  TeamMember,
} from "@/lib/api/generated/model";
import { personBody } from "./accounts-api";
import { teamBotOf } from "./bots-api";
import { personLearningBody, reviewBody } from "./learning-api";
import { SKILLS_PATH, skillBody } from "./skills-api";

/**
 * The team screens hold their layout at every width, in light and dark.
 *
 * The Teams list, a team's page, New team, and a Bot's Publish dialog with its teams to tick are
 * drawn in a real browser, in the app's real frame, because whether a row's buttons stay inside
 * the card, a long name gives way, or a dialog fits a phone is the browser's layout to decide. Each
 * is checked wide (1440), narrow (700, where the sidebar is a sheet) and at a phone's width (390):
 * the page never scrolls sideways, every control is whole inside the window, and a row's actions
 * never sit on top of its words.
 *
 * The list and a team's page are drawn three times over, as the three people who open them see
 * them: an admin of the organization, a maintainer of the team who is not an admin, and a member
 * who is neither. The menu under the person's name is drawn open, with Teams in it.
 *
 * The server's answers are served as routes at the API's addresses: an organization with five
 * teams, one from the company's directory and one under another, with long names among them.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/teams-screens-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each screen is saved as <screen>-<engine>-<theme>-<width>.png.
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

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 700, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

/**
 * Who is looking: an admin of the organization, a maintainer of Sales who is not an admin, one of
 * its members who is neither, an admin with no teams yet, or the one person of a personal OpenBot.
 */
type Persona = "admin" | "maintainer" | "member" | "no-teams" | "personal";

const person = (id: string, name: string, email: string) => ({
  id,
  name,
  email,
});
const DANA = person(
  "dana",
  "Dana Whitfield",
  "dana.whitfield@northwind.example",
);
const SAM = person("sam", "Sam Ortiz", "sam.ortiz@northwind.example");
const PRIYA = person("priya", "Priya Nair", "priya.nair@northwind.example");
const TOM = person("tom", "Tom Becker", "tom.becker@northwind.example");
// A long name and address, which is what a row has to give way to.
const ALEX = person(
  "alex",
  "Alexandria Montgomery-Fitzwilliam",
  "alexandria.montgomery-fitzwilliam@northwind-freight.example",
);
const PEOPLE = [DANA, SAM, PRIYA, TOM, ALEX];

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

/** Who is signed in: Dana administers the organization, Sam does not. */
const signedIn = (persona: Persona) =>
  persona === "maintainer" || persona === "member" ? SAM : DANA;

/** The organization's teams, each with the server's verdicts on what this person may do to it. */
function teamsFor(persona: Persona): Team[] {
  if (persona === "no-teams" || persona === "personal") return [];
  const admin = persona === "admin";
  // An admin manages, moves and deletes every team; anybody else only manages one they maintain.
  const verdicts = { canManage: admin, canMove: admin, canDelete: admin };
  return [
    team("team_sales", "Sales", {
      description: "Everybody who sells.",
      memberCount: 4,
      role: persona === "member" ? "member" : "maintainer",
      ...verdicts,
      canManage: persona !== "member",
    }),
    team("team_emea", "Sales EMEA", {
      description:
        "Quotes, renewals and partner deals for Europe, the Middle East and Africa, with the Dublin and Dubai desks.",
      parentTeamId: "team_sales",
      memberCount: 1,
      ...verdicts,
    }),
    team("team_success", "Customer Success and Renewals, North America", {
      memberCount: 23,
      role: admin ? null : "member",
      ...verdicts,
    }),
    team("team_support", "Support", verdicts),
    team("team_finance", "Finance", {
      source: "directory",
      memberCount: 12,
      canManage: false,
      canMove: admin,
      canDelete: false,
    }),
  ];
}

/** The people in each team, with the one who is asking marked as the server marks them. */
function membersFor(persona: Persona): Record<string, TeamMember[]> {
  const me = signedIn(persona);
  const member = (
    who: { id: string; name: string; email: string },
    role: TeamMember["role"],
  ): TeamMember => ({
    id: who.id,
    email: who.email,
    name: who.name,
    image: null,
    role,
    isCaller: who.id === me.id,
    joinedAt: "2026-11-15T09:13:02.000Z",
  });
  return {
    team_sales: [
      member(DANA, "maintainer"),
      member(SAM, persona === "maintainer" ? "maintainer" : "member"),
      member(ALEX, "member"),
      member(PRIYA, "maintainer"),
    ],
    team_finance: [member(TOM, "member"), member(ALEX, "member")],
  };
}

const BOT = {
  ...getGetBotResponseMock().bot,
  id: "expenses",
  name: "Expenses",
  mine: true,
  canManage: true,
  visibility: "private" as const,
};

/** Published to a person, a team and a directory group from before there were teams, and assigned. */
const PUBLISHED: TeamBot = teamBotOf("expenses", "Expenses", {
  audience: "people",
  people: ["sam.ortiz@northwind.example"],
  teams: ["team_sales"],
  groups: ["finance"],
  assignedGroups: ["*", "team:team_success", "finance"],
});

/** What the API answers for one read, or undefined for an address these screens never ask. */
function answer(
  path: string,
  persona: Persona,
  query = new URLSearchParams(),
): unknown {
  const me = signedIn(persona);
  const admin = me === DANA;
  const teams = teamsFor(persona);
  if (path === `${ORGANIZATION}/deployment`)
    return {
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: persona === "personal" ? "personal" : "team",
      authProviders: [],
      ssoConfigured: false,
      ssoRequired: false,
    };
  if (path === `${ORGANIZATION}/people/me`)
    return {
      person: personBody({ ...me, role: admin ? "admin" : "member" }),
      openbotVersion: "v1.0.3",
    };
  if (path === `${ORGANIZATION}/people`)
    return {
      people: PEOPLE.map((one) =>
        personBody({ ...one, role: one === DANA ? "admin" : "member" }),
      ),
      nextCursor: null,
    };
  if (path === `${ORGANIZATION}/members`) {
    // The server's search: a name, a word of it or an address starting with it first, then any
    // that hold it, ignoring case.
    const typed = query.get("search")?.trim().toLowerCase() ?? "";
    const rank = (one: (typeof PEOPLE)[number]) => {
      const name = one.name.toLowerCase();
      const email = one.email.toLowerCase();
      if (
        name.startsWith(typed) ||
        name.includes(` ${typed}`) ||
        email.startsWith(typed)
      )
        return 0;
      return name.includes(typed) || email.includes(typed) ? 1 : 2;
    };
    const found = typed
      ? PEOPLE.filter((one) => rank(one) < 2).sort(
          (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
        )
      : PEOPLE;
    return {
      members: found.map(
        (one): OrganizationMember => ({
          id: one.id,
          email: one.email,
          name: one.name,
          image: null,
          role: one === DANA ? "admin" : "member",
          joinedAt: "2026-11-01T09:00:00.000Z",
          removable: false,
          assignableRoles: [],
        }),
      ),
      nextCursor: null,
    };
  }
  if (path === `${ORGANIZATION}/teams`)
    return { teams, canCreate: admin, nextCursor: null };
  const one = /\/teams\/([^/]+)(\/members)?$/.exec(path);
  if (one) {
    const found = teams.find((candidate) => candidate.id === one[1]);
    if (!found) return undefined;
    return one[2]
      ? { members: membersFor(persona)[found.id] ?? [], nextCursor: null }
      : { team: found };
  }
  // Skills, a page of the app's frame that was there before, to look at beside Teams.
  if (path === SKILLS_PATH)
    return {
      skills: [
        skillBody({
          slug: "weekly-report",
          title: "Weekly report",
          summary: "Summarize the week's closed deals for the Monday meeting.",
          ownerUserId: me.id,
        }),
        skillBody({
          slug: "expense-check",
          title: "Expense check",
          summary: "Check a receipt against the travel policy.",
          ownerUserId: me.id,
        }),
      ],
      nextCursor: null,
    };
  if (path === `${ORGANIZATION}/bots`) return { bots: [BOT], nextCursor: null };
  if (path === `${ORGANIZATION}/people/me/learning-settings`)
    return personLearningBody();
  if (path === `${ORGANIZATION}/people/me/learning-review`) return reviewBody();
  if (path === `${ORGANIZATION}/team-bots`)
    return { teamBots: [PUBLISHED], nextCursor: null };
  if (path === `${ORGANIZATION}/bots/expenses`) return { bot: BOT };
  if (path.includes("/shared-use/bot/")) return { apps: [] };
  if (path.includes("/shared-use")) return { requests: [] };
  return undefined;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "teams-screens.fixture.tsx")],
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

/** One screen: where it is, who looks at it, and what makes it ready to be looked at. */
type Screen = {
  name: string;
  path: string;
  persona?: Persona;
  /** Every engine, theme and width, or (for a state of a screen already covered) a few of them. */
  everywhere?: boolean;
  ready: (page: Page) => Promise<unknown>;
  /**
   * What the person does next, once the screen is styled: for something that is pressed where it
   * is drawn (the sidebar's sheet in a narrow window, and the menu in it).
   */
  press?: (page: Page) => Promise<unknown>;
  /** Drawn only to be looked at beside the team screens, when screenshots are asked for. */
  lookOnly?: boolean;
  /** Where to look, once the screen is styled: a part of the page further down. */
  lookAt?: (page: Page) => Promise<unknown>;
};

const SCREENS: Screen[] = [
  {
    name: "teams-list",
    path: "/teams",
    everywhere: true,
    ready: (page) => page.getByRole("link", { name: /^Sales EMEA/ }).waitFor(),
  },
  {
    name: "team-page",
    path: "/teams/team_sales",
    everywhere: true,
    ready: (page) => page.getByText("Sam Ortiz").waitFor(),
  },
  {
    name: "new-team",
    path: "/teams/new",
    everywhere: true,
    ready: (page) => page.getByLabel("Parent team").waitFor(),
  },
  {
    name: "publish-dialog",
    path: "/bots/expenses/sharing",
    everywhere: true,
    ready: async (page) => {
      await page.getByRole("button", { name: /Audience/ }).click();
      await page
        .getByRole("dialog")
        .getByRole("checkbox", { name: "Sales", exact: true })
        .waitFor();
    },
  },
  {
    name: "teams-list-empty",
    path: "/teams",
    persona: "no-teams",
    ready: (page) => page.getByText("No teams yet").waitFor(),
  },
  // The same two screens as the people who are not admins see them.
  {
    name: "teams-list-member",
    path: "/teams",
    persona: "member",
    everywhere: true,
    ready: (page) => page.getByRole("link", { name: /^Sales EMEA/ }).waitFor(),
  },
  {
    name: "teams-list-maintainer",
    path: "/teams",
    persona: "maintainer",
    everywhere: true,
    ready: (page) => page.getByRole("link", { name: /^Sales EMEA/ }).waitFor(),
  },
  {
    name: "team-page-member",
    path: "/teams/team_sales",
    persona: "member",
    everywhere: true,
    ready: (page) => page.getByRole("button", { name: "Leave team" }).waitFor(),
  },
  {
    name: "team-page-maintainer",
    path: "/teams/team_sales",
    persona: "maintainer",
    everywhere: true,
    ready: (page) => page.getByRole("button", { name: "Leave team" }).waitFor(),
  },
  // Where Teams is reached: the menu under the person's name, open. In a narrow window the
  // sidebar is a sheet, opened first.
  {
    name: "teams-menu-member",
    path: "/teams",
    persona: "member",
    everywhere: true,
    ready: (page) => page.getByRole("link", { name: /^Sales EMEA/ }).waitFor(),
    press: async (page) => {
      const account = page.getByRole("button", { name: /Sam Ortiz/ });
      if ((await account.count()) === 0) {
        await page.getByRole("button", { name: "Show sidebar" }).click();
        // Styled as a sheet before anything in it is pressed.
        await account.waitFor();
        const classes = await page.evaluate(() =>
          [...document.querySelectorAll("[class]")].flatMap((element) => [
            ...element.classList,
          ]),
        );
        await page.addStyleTag({
          content: await stylesheet([...new Set(classes)]),
        });
        await page.waitForTimeout(400);
      }
      await account.click();
      await page.getByRole("menuitem", { name: "Teams" }).waitFor();
    },
  },
  // A page of the app's frame that was there before, to look at beside the new ones. It is
  // another area's page, so it is drawn when screenshots are asked for and held to nothing here.
  {
    name: "skills-page-member",
    path: "/skills",
    persona: "member",
    everywhere: true,
    lookOnly: true,
    ready: (page) => page.getByText("Weekly report").waitFor(),
  },
  {
    name: "team-page-directory",
    path: "/teams/team_finance",
    ready: (page) => page.getByText("Tom Becker").waitFor(),
  },
  // Adding people: the box as it opens, what typing finds (with the long name, and people in the
  // team already), the best match completed in the box, nobody found, and somebody just added.
  {
    name: "add-person-dialog",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      await page.getByRole("combobox", { name: "Name or email" }).waitFor();
    },
  },
  {
    name: "add-person-dialog-results",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      await page.getByRole("combobox", { name: "Name or email" }).fill("a");
      await page.getByRole("option", { name: /Tom Becker/ }).waitFor();
    },
  },
  {
    name: "add-person-dialog-completion",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      await page
        .getByRole("combobox", { name: "Name or email" })
        .pressSequentially("to");
      await page.getByRole("option", { name: /Tom Becker/ }).waitFor();
      await page
        .getByRole("combobox", { name: "Name or email" })
        .and(page.locator("[value='Tom Becker']"))
        .waitFor();
    },
  },
  // Tab takes the completion in the browser's own key handling: the caret goes to the end, and a
  // letter typed then is added after the name, not put in place of what was completed.
  {
    name: "add-person-dialog-tab-taken",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      const box = page.getByRole("combobox", { name: "Name or email" });
      await box.pressSequentially("to");
      await box.and(page.locator("[value='Tom Becker']")).waitFor();
      await box.press("Tab");
      // By its label: the team page behind the dialog has role menus that are comboboxes too.
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLInputElement>(
          "input[aria-label='Name or email']",
        );
        return (
          input?.value === "Tom Becker" &&
          input.selectionStart === 10 &&
          input.selectionEnd === 10 &&
          document.activeElement === input
        );
      });
      await box.press("x");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>(
            "input[aria-label='Name or email']",
          )?.value === "Tom Beckerx",
      );
    },
  },
  {
    name: "add-person-dialog-no-match",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      await page.getByRole("combobox", { name: "Name or email" }).fill("zzz");
      await page.getByText(/^Nobody in this organization matches/).waitFor();
    },
  },
  // Escape closes the list and leaves the dialog open, in a real browser's own key handling.
  {
    name: "add-person-dialog-escape",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      const box = page.getByRole("combobox", { name: "Name or email" });
      await box.pressSequentially("to");
      await page.getByRole("option", { name: /Tom Becker/ }).waitFor();
      await box.press("Escape");
      await page
        .locator("[role=combobox][aria-expanded=false][value=to]")
        .waitFor();
      await page.getByRole("dialog", { name: "Add people to Sales" }).waitFor();
    },
  },
  {
    name: "add-person-dialog-added",
    path: "/teams/team_sales",
    ready: async (page) => {
      await page.getByRole("button", { name: "Add person" }).click();
      const box = page.getByRole("combobox", { name: "Name or email" });
      await box.pressSequentially("to");
      await page.getByRole("option", { name: /Tom Becker/ }).waitFor();
      await box.press("Enter");
      await page.getByRole("region", { name: "Added to Sales" }).waitFor();
    },
  },
  {
    name: "sharing-page",
    path: "/bots/expenses/sharing",
    ready: (page) =>
      page.getByText("Customer Success and Renewals, North America").waitFor(),
  },
  {
    name: "assign-dialog",
    path: "/bots/expenses/sharing",
    ready: async (page) => {
      await page
        .getByRole("button", { name: /Assign to a team or everyone/ })
        .click();
      await page.getByRole("combobox", { name: "Assign to" }).waitFor();
    },
  },
  // The same team screens as Admin draws them, in its frame, for an admin who opened them there.
  {
    name: "admin-teams-list",
    path: "/admin/teams",
    everywhere: true,
    ready: (page) => page.getByRole("link", { name: /^Sales EMEA/ }).waitFor(),
  },
  {
    name: "admin-team-page",
    path: "/admin/teams/team_sales",
    everywhere: true,
    ready: (page) => page.getByText("Sam Ortiz").waitFor(),
  },
  {
    name: "admin-new-team",
    path: "/admin/teams/new",
    everywhere: true,
    ready: (page) => page.getByLabel("Parent team").waitFor(),
  },
  // The personal edition keeps Teams in Admin's sidebar, saying it is for a team, as People does.
  {
    name: "admin-teams-personal",
    path: "/admin/teams",
    persona: "personal",
    ready: (page) => page.getByText("For a team", { exact: true }).waitFor(),
  },
  // Two Admin pages that were there before, to look at beside the new ones.
  {
    name: "admin-overview",
    path: "/admin",
    ready: (page) =>
      page.getByRole("heading", { name: "Organization" }).waitFor(),
    // Where Teams is: the last group, Organization, at the foot of the page.
    lookAt: (page) =>
      page
        .getByRole("heading", { name: "Organization" })
        .evaluate((heading) => heading.scrollIntoView({ block: "start" })),
  },
  {
    name: "admin-people",
    path: "/admin/people",
    ready: (page) => page.getByText("Sam Ortiz").waitFor(),
  },
];

/** Where a screen is drawn: every combination, or a wide and a phone window in both themes. */
function combinations(screen: Screen) {
  const all: { engine: string; theme: Theme; window: Window }[] = [];
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of [WIDE, NARROW, PHONE]) {
        if (
          screen.everywhere ||
          (window !== NARROW && (engine === "chromium" || theme === "light"))
        )
          all.push({ engine, theme, window });
      }
  return all;
}

const css = new Map<string, string>();

async function open(
  screen: Screen,
  engine: string,
  theme: Theme,
  window: Window,
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
  const persona = screen.persona ?? "admin";
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      // Adding somebody to a team: the person, in the team as a member.
      const added = /\/teams\/[^/]+\/members\/([^/]+)$/.exec(path);
      if (route.request().method() === "PUT" && added) {
        const who = PEOPLE.find((one) => one.id === added[1]);
        return who
          ? route.fulfill({
              json: {
                member: {
                  ...who,
                  image: null,
                  role: "member",
                  isCaller: false,
                  joinedAt: "2026-11-19T09:00:00.000Z",
                },
              },
            })
          : route.fulfill({ status: 404, json: { detail: "Not found." } });
      }
      const body = answer(
        path,
        persona,
        new URL(route.request().url()).searchParams,
      );
      return body === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json: body });
    }
    // Every other address is the app's own page, as its server answers it.
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${screen.path}`);
  await screen.ready(page);
  // Built once a screen and width, for the classes it draws with its dialog open. A narrow
  // window draws other things than a wide one (the sidebar as a sheet), so each has its own.
  const style = async (key: string) => {
    let sheet = css.get(key);
    if (!sheet) {
      const classes = await page.evaluate(() =>
        [...document.querySelectorAll("[class]")].flatMap((element) => [
          ...element.classList,
        ]),
      );
      sheet = await stylesheet([...new Set(classes)]);
      css.set(key, sheet);
    }
    await page.addStyleTag({ content: sheet });
  };
  await style(`${screen.name}-${window.width}`);
  await page.evaluate(() => document.fonts.ready);
  if (screen.press) {
    await screen.press(page);
    // What that opened is drawn with classes of its own.
    await style(`${screen.name}-${window.width}-pressed`);
  }
  await screen.lookAt?.(page);
  // Rows ease in and a dialog scales up: looked at once they are still.
  await page.waitForTimeout(400);
  return page;
}

/** What a person would see wrong: sideways scroll, a control cut off, words under a button. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
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
      // Not the sidebar's edge strip: nothing is drawn on it, and it straddles the edge it is on.
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
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
    return {
      sideways:
        document.documentElement.scrollWidth > innerWidth ||
        document.body.scrollWidth > innerWidth,
      cut,
      overlapping,
      squeezed,
      dialogInside: box
        ? inside(box) && box.top >= 0 && box.bottom <= innerHeight + 0.5
        : true,
    };
  });
}

/**
 * How the backdrop behind an open dialog is styled, as the browser computed it: how dark it is, and
 * the blur it asks for under the standard name and under WebKit's own.
 */
async function backdrop(page: Page) {
  return page.evaluate(() => {
    const overlay = document.querySelector("[data-slot=dialog-overlay]");
    if (!overlay) return null;
    const style = getComputedStyle(overlay);
    // The last number of the colour is its alpha: `oklab(0 0 0 / 0.1)`, `rgba(0, 0, 0, 0.1)`.
    const parts = style.backgroundColor.match(/[\d.]+/g) ?? [];
    return {
      covers:
        overlay.getBoundingClientRect().width >= innerWidth &&
        overlay.getBoundingClientRect().height >= innerHeight,
      dim: parts.length === 4 ? Number(parts[3]) : 1,
      opacity: Number(style.opacity),
      blur: style.getPropertyValue("backdrop-filter"),
      webkitBlur: style.getPropertyValue("-webkit-backdrop-filter"),
    };
  });
}

/*
 * Every dialog in the app is drawn by one primitive (components/ui/dialog.tsx), whose backdrop dims
 * the page a little and blurs it, so the dialog is not read against the words behind it. Checked in
 * each engine as what the browser computed, in both of the blur's spellings where it has both.
 *
 * NOT CHECKED HERE: THAT THE BLUR IS PAINTED. Headless WebKit computes the blur and does not paint
 * it in a screenshot, on any page: one fixed `div` with `backdrop-filter: blur(12px)` over a
 * paragraph comes out sharp. So a WebKit screenshot of a dialog shows the page behind it dimmed and
 * unblurred, whatever this primitive does.
 */
describe.skipIf(!asked)("a dialog's backdrop", () => {
  const publish = SCREENS.find((screen) => screen.name === "publish-dialog");
  if (!publish) throw new Error("no publish dialog");
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of [WIDE, PHONE])
        test(`is styled to dim and blur the page behind it in ${engine}, ${theme}, ${window.width}px`, async () => {
          const page = await open(publish, engine, theme, window);
          try {
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot({
                path: join(
                  shots,
                  `dialog-backdrop-${engine}-${theme}-${window.width}.png`,
                ),
              });
            }
            const drawn = await backdrop(page);
            expect(drawn).toMatchObject({ covers: true, opacity: 1 });
            expect(drawn?.dim).toBeGreaterThan(0);
            expect(drawn?.blur).toMatch(/^blur\(\d/);
            // WebKit keeps its own spelling beside the standard one; both have to say blur.
            if (engine === "webkit")
              expect(drawn?.webkitBlur).toMatch(/^blur\(\d/);
          } finally {
            await page.close();
          }
        }, 60_000);
});

describe.skipIf(!asked)("the team screens", () => {
  for (const screen of SCREENS) {
    if (screen.lookOnly && !shots) continue;
    for (const { engine, theme, window } of combinations(screen)) {
      test(`${screen.name} holds its layout in ${engine}, ${theme}, ${window.width}px`, async () => {
        const page = await open(screen, engine, theme, window);
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
          if (screen.lookOnly) return;
          expect(await measured(page)).toEqual({
            sideways: false,
            cut: [],
            overlapping: [],
            squeezed: [],
            dialogInside: true,
          });
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});

/** Styles what the page draws now: a click drew a page the first stylesheet was not built for. */
async function restyle(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.waitForTimeout(400);
}

/** Saves what the page shows now, when screenshots are asked for. */
async function shoot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** Admin's frame is drawn: its way back to the app is there. */
const backTo = (page: Page) =>
  page.getByRole("link", { name: "Back to app" }).waitFor();

/** Admin's sidebar entry for Teams: the link inside the sidebar, not a back button on the page. */
const sidebarTeams = (page: Page) =>
  page.locator('[data-slot="sidebar"]').getByRole("link", { name: "Teams" });

/*
 * Teams opened from Admin stays in Admin: from People, the sidebar's Teams opens the list in
 * Admin's frame with Teams the current entry, a team opens under it, and its back button returns
 * there. The app's own Teams, from the menu under the person's name, is still the app's page. In
 * a wide window, where the sidebar is beside the page rather than a sheet over it.
 */
describe.skipIf(!asked)("Teams opened from Admin", () => {
  const people = SCREENS.find((screen) => screen.name === "admin-people");
  const skills = SCREENS.find((screen) => screen.name === "skills-page-member");
  if (!people || !skills) throw new Error("no People or Skills screen");
  for (const engine of engines)
    for (const theme of THEMES) {
      test(`stays in Admin, and the app's Teams stays in the app, in ${engine}, ${theme}`, async () => {
        const page = await open(people, engine, theme, WIDE);
        const tag = `${engine}-${theme}`;
        const backToApp = page.getByRole("link", { name: "Back to app" });
        const inAdmin = async (path: string) => {
          expect(new URL(page.url()).pathname).toBe(path);
          expect(await backToApp.isVisible()).toBe(true);
          expect(await sidebarTeams(page).getAttribute("data-status")).toBe(
            "active",
          );
        };
        try {
          await sidebarTeams(page).click();
          await page.getByRole("link", { name: /^Sales EMEA/ }).waitFor();
          await restyle(page);
          await inAdmin("/admin/teams");
          await shoot(page, `flow-admin-teams-${tag}`);

          await page.getByRole("link", { name: /^Sales\b(?! EMEA)/ }).click();
          await page.getByText("Sam Ortiz").waitFor();
          await restyle(page);
          await inAdmin("/admin/teams/team_sales");
          await shoot(page, `flow-admin-team-${tag}`);

          await page.getByRole("button", { name: "Teams" }).click();
          await page.getByRole("button", { name: "New team" }).first().click();
          await page.getByLabel("Parent team").waitFor();
          await restyle(page);
          await inAdmin("/admin/teams/new");
          await shoot(page, `flow-admin-new-team-${tag}`);
        } finally {
          await page.close();
        }

        // The app's Teams, from the menu under the person's name: the app's frame, not Admin's.
        const app = await open(
          { ...skills, persona: "admin" },
          engine,
          theme,
          WIDE,
        );
        try {
          await app.getByRole("button", { name: /Dana Whitfield/ }).click();
          const entry = app.getByRole("menuitem", { name: "Teams" });
          await entry.waitFor();
          // The menu is drawn with classes of its own, styled before it is pressed.
          await restyle(app);
          expect(await entry.getAttribute("href")).toBe("/teams");
          await shoot(app, `flow-app-menu-${tag}`);
          await entry.click();
          await app.getByRole("link", { name: /^Sales EMEA/ }).waitFor();
          await restyle(app);
          expect(new URL(app.url()).pathname).toBe("/teams");
          expect(
            await app.getByRole("link", { name: "Back to app" }).count(),
          ).toBe(0);
          await shoot(app, `flow-app-teams-${tag}`);
        } finally {
          await app.close();
        }
      }, 60_000);

      test(`in the personal edition, says it is for a team, inside Admin, in ${engine}, ${theme}`, async () => {
        const page = await open(
          { ...people, persona: "personal", ready: (one) => backTo(one) },
          engine,
          theme,
          WIDE,
        );
        try {
          await sidebarTeams(page).click();
          await page.getByText("For a team", { exact: true }).waitFor();
          await restyle(page);
          expect(new URL(page.url()).pathname).toBe("/admin/teams");
          expect(
            await page.getByRole("link", { name: "Back to app" }).isVisible(),
          ).toBe(true);
          expect(await sidebarTeams(page).getAttribute("data-status")).toBe(
            "active",
          );
          await shoot(page, `flow-admin-teams-personal-${engine}-${theme}`);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
});
