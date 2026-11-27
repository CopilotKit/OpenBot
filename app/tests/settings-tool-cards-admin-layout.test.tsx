import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page } from "playwright-core";
import { compile } from "tailwindcss";
import type {
  OrganizationMember,
  Team,
  TeamMember,
} from "@/lib/api/generated/model";
import { personBody } from "./accounts-api";
import { deploymentBody, overviewResponse } from "./admin-settings-api";
import { approvalInboxResponse } from "./approvals-api";
import { marksPlugin } from "./marks-plugin";
import { still } from "./page-still";
import { screenLinkLooks } from "./screen-link-style";
import { CALLS, waitingRequests } from "./settings-tool-cards-admin.calls";

/**
 * The admin settings tools' cards hold their layout in a conversation, and read as the Admin screens
 * they change, in light and dark, wide and at a phone's width, in Chromium and WebKit.
 *
 * Drawn in a real browser in the app's real frame (settings-tool-cards-admin.fixture.tsx): a change
 * to the organization's settings, a person made an admin, invited and removed, and a team moved and
 * given a maintainer, each waiting for approval and once answered. Beside them, the screens the
 * changes show on: People, Permissions, a team's page and Organization settings. Each approval is
 * titled with what it does in plain words, and each card opens its screens with the link every
 * settings card uses.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/settings-tool-cards-admin-layout.test.tsx
 *
 * Chromium by default. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With OPENBOT_APP_SHOTS=<dir>
 * each screen is saved as <screen>-<engine>-<theme>-<width>.png.
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
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

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
const ALEX = person(
  "alex",
  "Alexandria Montgomery-Fitzwilliam",
  "alexandria.montgomery-fitzwilliam@northwind-freight.example",
);
const PEOPLE = [DANA, SAM, PRIYA, TOM, ALEX];

/** The organization after the changes the cards say were made. */
const ROLES: Record<string, "owner" | "admin" | "member"> = {
  dana: "owner",
  sam: "admin",
  priya: "member",
  tom: "member",
  alex: "member",
};

const CAPABILITIES = [
  ["useBots", "Use Bots"],
  ["cloudBrowser", "Cloud browser use"],
  ["customRules", "Custom rules"],
  ["proactive", "Check-ins"],
] as const;

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
const TEAMS = [
  team("team_sales", "Sales", { memberCount: 5 }),
  team("team_emea", "Sales EMEA", {
    parentTeamId: "team_sales",
    memberCount: 3,
  }),
];
const teamMember = (
  who: (typeof PEOPLE)[number],
  role: TeamMember["role"],
): TeamMember => ({
  id: who.id,
  email: who.email,
  name: who.name,
  image: null,
  role,
  isCaller: who === DANA,
  joinedAt: "2026-11-15T09:13:02.000Z",
});

/** What the API answers for one read, or undefined for an address these screens never ask. */
function answer(path: string): unknown {
  if (path === `${ORGANIZATION}/deployment`) return deploymentBody();
  if (path === `${ORGANIZATION}/people/me`)
    return {
      person: personBody({ ...DANA, role: "owner" as never }),
      openbotVersion: "v1.4.0",
    };
  if (path === `${ORGANIZATION}/people`)
    return {
      people: PEOPLE.map((one) =>
        personBody({ ...one, role: ROLES[one.id] as never }),
      ),
      nextCursor: null,
    };
  if (path === `${ORGANIZATION}/members`)
    return {
      members: PEOPLE.map(
        (one): OrganizationMember => ({
          id: one.id,
          email: one.email,
          name: one.name,
          image: null,
          role: ROLES[one.id] ?? "member",
          joinedAt: "2026-11-01T09:00:00.000Z",
          removable: one !== DANA,
          assignableRoles: one === DANA ? [] : ["admin", "member"],
        }),
      ),
      nextCursor: null,
    };
  if (path === "/api/v2/people/me/organizations")
    return {
      organizations: [
        {
          id: "default",
          slug: "northwind",
          name: "Northwind Freight",
          role: "owner",
          active: true,
          personal: false,
          joinedAt: "2026-11-01T09:00:00.000Z",
        },
      ],
      canCreate: true,
      nextCursor: null,
    };
  if (path === `${ORGANIZATION}/invitations`)
    return {
      invitations: [
        {
          id: "inv_4f2c91",
          email: "lena.koch@northwind.example",
          role: "member",
          status: "pending",
          invitedBy: { name: DANA.name, email: DANA.email },
          createdAt: "2026-11-23T09:00:00.000Z",
          expiresAt: "2026-11-30T09:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
  if (path === `${ORGANIZATION}/teams`)
    return { teams: TEAMS, canCreate: true, nextCursor: null };
  // No team here limits its models.
  if (/\/teams\/[^/]+\/models$/.test(path))
    return { models: null, updatedBy: null, updatedAt: null };
  const one = /\/teams\/([^/]+)(\/members)?$/.exec(path);
  if (one) {
    const found = TEAMS.find((candidate) => candidate.id === one[1]);
    if (!found) return undefined;
    return one[2]
      ? {
          members:
            found.id === "team_emea"
              ? [
                  teamMember(PRIYA, "maintainer"),
                  teamMember(SAM, "member"),
                  teamMember(ALEX, "member"),
                ]
              : [teamMember(DANA, "maintainer"), teamMember(TOM, "maintainer")],
          nextCursor: null,
        }
      : { team: found };
  }
  return undefined;
}

/** The settings screens' reads, as the organization stands after the settings card's change. */
async function overview(path: string): Promise<unknown> {
  const response = overviewResponse(path, {
    settings: { actionRecording: true, proactiveDailyRuns: 6 },
    capabilities: CAPABILITIES.map(([capability, title]) => ({
      capability,
      title,
      description: `${title} for everybody.`,
      default: true,
      organization: null,
      roles: (capability === "proactive" ? { member: false } : {}) as Record<
        string,
        boolean
      >,
      groups: {},
      teams: {},
    })),
  });
  return response ? await response.json() : undefined;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, "settings-tool-cards-admin.fixture.tsx"),
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // A team's Models dialog draws each model's maker.
    plugins: [marksPlugin],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

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
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

type Screen = {
  name: string;
  path: string;
  ready: (page: Page) => Promise<unknown>;
  /**
   * A card scene: held to the layout and to what a card must show, in a window tall enough to see
   * the whole conversation at once. Otherwise an Admin screen, drawn only to be looked at beside
   * the cards when screenshots are asked for: they are other areas' screens, held to nothing here.
   */
  cards?: boolean;
};

/** Each scene's waiting approvals, by title: what the change does, as a person would say it. */
const APPROVAL_TITLES: Record<string, string[]> = {
  settings: ["Change your organization's settings"],
  people: ["Change someone's role in your organization"],
  teams: ["Move a team"],
};

const SCREENS: Screen[] = [
  {
    name: "cards-settings",
    path: "/conversation/settings",
    cards: true,
    ready: async (page) => {
      await page
        .getByRole("region", { name: "Waiting for your approval" })
        .waitFor();
      await page.getByText("Open Permissions").waitFor();
    },
  },
  {
    name: "cards-people",
    path: "/conversation/people",
    cards: true,
    ready: async (page) => {
      await page
        .getByRole("region", { name: "Waiting for your approval" })
        .waitFor();
      await page.getByRole("button", { name: /Copy link for/ }).waitFor();
    },
  },
  {
    name: "cards-teams",
    path: "/conversation/teams",
    cards: true,
    ready: async (page) => {
      await page
        .getByRole("region", { name: "Waiting for your approval" })
        .waitFor();
      await page.getByText("Add Tom Becker to Sales").waitFor();
    },
  },
  {
    name: "admin-permissions",
    path: "/admin/permissions",
    ready: (page) => page.getByText("Role and team overrides").waitFor(),
  },
  {
    name: "admin-people",
    path: "/admin/people",
    ready: (page) => page.getByText("Sam Ortiz").waitFor(),
  },
  {
    name: "admin-team-page",
    path: "/admin/teams/team_emea",
    ready: (page) => page.getByText("Priya Nair").waitFor(),
  },
  {
    name: "organization-settings",
    path: "/settings/organization",
    ready: (page) => page.getByText("Sam Ortiz").waitFor(),
  },
];

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
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, path.split("/").pop() ?? "");
    if (path.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (path.startsWith("/api/")) {
      // What waits on the person: the approvals the waiting calls opened, with their previews.
      const approvals = approvalInboxResponse(path, {
        requests: waitingRequests(),
      });
      if (approvals)
        return route.fulfill({
          contentType: "application/json",
          body: await approvals.text(),
        });
      const body = answer(path) ?? (await overview(path));
      return body === undefined
        ? route.fulfill({ status: 404, json: { detail: "Not found." } })
        : route.fulfill({ json: body });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${screen.path}`);
  await screen.ready(page);
  const key = `${screen.name}-${window.width}`;
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
  await page.evaluate(() => document.fonts.ready);
  await still(page);
  return page;
}

/** What a person would see wrong: sideways scroll, a control cut off, words under a button. */
async function measured(page: Page) {
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const cut = [...document.querySelectorAll("button, a, input")]
      .filter(shown)
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map((control) => control.textContent?.trim() || control.tagName);
    const overlapping: string[] = [];
    for (const row of document.querySelectorAll("[data-slot=item]")) {
      if (!shown(row)) continue;
      const title = row.querySelector("[data-slot=item-title]");
      const actions = row.querySelector("[data-slot=item-actions]");
      if (!title || !actions) continue;
      const words = title.getBoundingClientRect();
      const buttons = actions.getBoundingClientRect();
      if (buttons.width === 0) continue;
      const apart =
        words.right <= buttons.left + 0.5 ||
        buttons.right <= words.left + 0.5 ||
        words.bottom <= buttons.top + 0.5 ||
        buttons.bottom <= words.top + 0.5;
      if (!apart) overlapping.push(title.textContent?.trim() ?? "");
    }
    // Every card's contents stay inside the card.
    const spilling: string[] = [];
    for (const card of document.querySelectorAll(
      "[data-slot=admin-change-card], [data-slot=decision-card]",
    )) {
      const box = card.getBoundingClientRect();
      for (const child of card.querySelectorAll("*")) {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0) continue;
        // A switch's own form input, kept out of sight by the switch, is not drawn.
        if (child.matches("input[aria-hidden=true], input[type=checkbox]"))
          continue;
        if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5)
          spilling.push(
            child.textContent?.trim().slice(0, 40) ?? child.tagName,
          );
      }
    }
    return {
      sideways:
        document.documentElement.scrollWidth > innerWidth ||
        document.body.scrollWidth > innerWidth,
      cut,
      overlapping,
      spilling: [...new Set(spilling)],
    };
  });
}

describe.skipIf(!asked)(
  "the admin settings cards and the screens they change",
  () => {
    for (const screen of SCREENS)
      for (const engine of engines)
        for (const theme of THEMES)
          for (const size of [WIDE, PHONE])
            test.skipIf(!screen.cards && !shots)(
              `${screen.name} in ${engine}, ${theme}, ${size.width}px`,
              async () => {
                // A conversation is looked at whole; a screen as it opens.
                const window = screen.cards ? { ...size, height: 3200 } : size;
                const page = await open(screen, engine, theme, window);
                try {
                  if (shots) {
                    mkdirSync(shots, { recursive: true });
                    await page.screenshot({
                      path: join(
                        shots,
                        `${screen.name}-${engine}-${theme}-${size.width}.png`,
                      ),
                    });
                  }
                  if (!screen.cards) return;
                  const found = await measured(page);
                  expect(found).toEqual({
                    sideways: false,
                    cut: [],
                    overlapping: [],
                    spilling: [],
                  });
                  if (screen.cards) {
                    const scene = screen.path.split("/").pop();
                    const calls = CALLS.filter((call) => call.scene === scene);
                    // Each call that ran or was refused is drawn as its own card, in the transcript.
                    expect(
                      await page
                        .locator("[data-slot=admin-change-card]")
                        .count(),
                    ).toBe(
                      calls.filter((call) => call.state !== "waiting").length,
                    );
                    // A waiting call's approval card draws the tool's own rows, with its before and after.
                    const waiting = page.getByRole("region", {
                      name: "Waiting for your approval",
                    });
                    expect(await waiting.count()).toBe(
                      calls.filter((call) => call.state === "waiting").length,
                    );
                    expect(
                      await waiting.getByTestId("before-after").count(),
                    ).toBeGreaterThan(0);
                    // Titled in plain words, never the tool's name on "OpenBot settings".
                    expect(
                      await waiting
                        .locator(
                          "[data-slot=decision-card] figcaption > div > p:first-child",
                        )
                        .allTextContents(),
                    ).toEqual(APPROVAL_TITLES[scene ?? ""] ?? []);
                    // Each card opens its screens with the link every settings card uses.
                    const links = await screenLinkLooks(
                      page,
                      "[data-slot=admin-change-card]",
                    );
                    expect(links.length).toBeGreaterThan(0);
                    for (const link of links)
                      expect(link).toMatchObject({
                        underlined: false,
                        chevron: true,
                        primary: true,
                        weight: "500",
                      });
                    // A refusal says why, in the server's words.
                    for (const call of calls.filter(
                      (one) => one.state === "refused",
                    ))
                      await page
                        .getByText(
                          call.result?.replace(/^Refused\. /, "") ?? "",
                        )
                        .waitFor();
                  }
                } finally {
                  await page.close();
                }
              },
              60_000,
            );
  },
);
