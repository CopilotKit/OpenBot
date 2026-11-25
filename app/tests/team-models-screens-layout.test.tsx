import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import { getGetBotResponseMock } from "@/lib/api/generated/bots/bots.msw";
import type {
  ModelCatalogue,
  Team,
  TeamMember,
} from "@/lib/api/generated/model";
import { GetAiConnectionResponse } from "@/lib/api/generated/models/models.zod";
import { personBody } from "./accounts-api";
import {
  CAPABILITIES_PATH,
  deploymentBody,
  NETWORK_POLICIES_PATH,
  SETTINGS_PATH,
  settingsBody,
} from "./admin-settings-api";
import { marksPlugin } from "./marks-plugin";

/**
 * A team's models, set by an admin and read by anybody, in a real browser.
 *
 * An admin opens a team in Admin, picks one model in the Models dialog, saves, and reads the
 * model's name on the row; then lets the team use everything the organization allows again. A
 * member opens the same team in the app and reads the row, with nothing to press. Admin, Providers
 * names the teams with a list of their own, each a link to its team. Every step in light and dark,
 * in a wide window and at a phone's width: the page never scrolls sideways, every control is whole
 * inside the window, a row's words are never under its actions, and a dialog fits the window.
 *
 * The server's answers are served as routes at the API's addresses, from one organization whose
 * admin allows two of the three models its provider lists; each team's list is kept as the server
 * keeps it, and the writes are recorded as they arrived.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/team-models-screens-layout.test.tsx
 *
 * Chromium by default, as CI has it. OPENBOT_APP_ENGINES=chromium,webkit adds WebKit. With
 * OPENBOT_APP_SHOTS=<dir> each step is saved as <step>-<engine>-<theme>-<width>.png.
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

const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as { components: { examples: Record<string, { value: unknown }> } };

const DANA = {
  id: "dana",
  name: "Dana Whitfield",
  email: "dana@northwind.example",
};
const SAM = { id: "sam", name: "Sam Ortiz", email: "sam@northwind.example" };

/** What the provider lists, newest first, as the catalogue's `view=all` answers. */
const LISTING: ModelCatalogue = {
  provider: "openai",
  source: "openai",
  exposure: "allowed",
  default: "gpt-5.6-terra",
  listed: true,
  choosable: true,
  models: [
    { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "openai" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "openai" },
    { id: "gpt-4o", label: "GPT-4o", vendor: "openai" },
    // As many again as a provider lists, so the Allowed models dialog has to scroll on a phone.
    ...[
      "gpt-5.1",
      "gpt-5-nano",
      "gpt-5-mini",
      "gpt-5",
      "o3-pro",
      "o3",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
    ].map((id) => ({
      id,
      label: id.toUpperCase().replace("GPT-", "GPT-"),
      vendor: "openai",
      efforts: ["low", "medium", "high"],
    })),
  ],
};
const ALLOWLIST = {
  enabled: true,
  models: ["openai/gpt-6-sol", "openai/gpt-5.6-terra"],
};

/** One model's runs over the last 30 days, as the usage view sums them. */
function usageRow(model: string, source: string, runs: number) {
  return {
    model,
    source,
    runs,
    refused: 0,
    people: 2,
    lastUsedAt: "2026-11-23T10:00:00.000Z",
  };
}

/** A team event on the trail, as the server records it: the team by id and by its name then. */
function teamEvent(
  id: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    actorUserId: DANA.id,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "team",
    targetId: "team_sales",
    payload: { team: "Sales", ...payload },
    createdAt: "2026-11-23T10:04:11.000Z",
  };
}

/** One organization as the server keeps it, for one page. */
class World {
  /** Each team's list; absent for a team that sets none. */
  lists: Record<string, string[]>;
  writes: { method: string; path: string; body: unknown }[] = [];
  /** Every read of the trail, by its query. */
  auditQueries: string[] = [];
  constructor(
    readonly persona: "admin" | "member",
    lists: Record<string, string[]> = {},
  ) {
    this.lists = { ...lists };
  }

  get me() {
    return this.persona === "admin" ? DANA : SAM;
  }

  teams(): Team[] {
    const admin = this.persona === "admin";
    const team = (
      id: string,
      name: string,
      description: string | null,
    ): Team => ({
      id,
      name,
      description,
      parentTeamId: null,
      source: "openbot",
      memberCount: 2,
      role: admin ? "maintainer" : "member",
      canManage: admin,
      canMove: admin,
      canDelete: admin,
      createdAt: "2026-11-15T09:12:40.000Z",
    });
    return [
      team("team_sales", "Sales", "Everybody who sells."),
      team("team_eng", "Engineering", null),
      team(
        "team_success",
        "Customer Success and Renewals, North America",
        null,
      ),
    ];
  }

  answer(request: Request): { status: number; json?: unknown } {
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const models = /\/teams\/([^/]+)\/models$/.exec(path);
    if (models) {
      const teamId = models[1] as string;
      if (method === "PUT") {
        const body = request.postDataJSON() as { models: string[] };
        this.writes.push({ method, path, body });
        this.lists[teamId] = body.models;
      } else if (method === "DELETE") {
        this.writes.push({ method, path, body: null });
        delete this.lists[teamId];
        return { status: 204 };
      }
      const list = this.lists[teamId] ?? null;
      return {
        status: 200,
        json: {
          models: list,
          updatedBy: list ? DANA.id : null,
          updatedAt: list ? "2026-11-23T10:04:11.000Z" : null,
        },
      };
    }
    if (path === `${ORGANIZATION}/deployment`)
      return { status: 200, json: deploymentBody({ edition: "team" }) };
    if (path === `${ORGANIZATION}/people/me`)
      return {
        status: 200,
        json: {
          person: personBody({
            ...this.me,
            role: this.persona === "admin" ? "admin" : "member",
          }),
          openbotVersion: "v1.2.0",
        },
      };
    if (path === `${ORGANIZATION}/teams`)
      return {
        status: 200,
        json: {
          teams: this.teams(),
          canCreate: this.persona === "admin",
          nextCursor: null,
        },
      };
    const one = /\/teams\/([^/]+)(\/members)?$/.exec(path);
    if (one) {
      const found = this.teams().find((team) => team.id === one[1]);
      if (!found) return { status: 404, json: { detail: "Not found." } };
      const member = (
        who: typeof DANA,
        role: TeamMember["role"],
      ): TeamMember => ({
        ...who,
        image: null,
        role,
        isCaller: who.id === this.me.id,
        joinedAt: "2026-11-15T09:13:02.000Z",
      });
      return {
        status: 200,
        json: one[2]
          ? {
              members: [member(DANA, "maintainer"), member(SAM, "member")],
              nextCursor: null,
            }
          : { team: found },
      };
    }
    if (path === `${ORGANIZATION}/model-catalogue`) {
      if (url.searchParams.get("view") === "all")
        return { status: 200, json: LISTING };
      // What this person may pick: their team's list, within the allowlist.
      const mine = this.lists.team_sales ?? ALLOWLIST.models;
      return {
        status: 200,
        json: {
          ...LISTING,
          models: LISTING.models.filter((model) =>
            mine.includes(`openai/${model.id}`),
          ),
        },
      };
    }
    // The Bot a refused run was for, so Activity names it.
    if (path === `${ORGANIZATION}/bots`)
      return {
        status: 200,
        json: {
          bots: [
            {
              ...getGetBotResponseMock().bot,
              id: "atlas",
              name: "Atlas",
            },
          ],
          nextCursor: null,
        },
      };
    if (path === `${ORGANIZATION}/ai-connection`)
      return {
        status: 200,
        json: GetAiConnectionResponse.parse({
          ...(spec.components.examples.AiConnectionExample?.value as object),
          provider: "openai",
        }),
      };
    if (path === `${ORGANIZATION}/model-usage`)
      return {
        status: 200,
        json: {
          days: 30,
          summary: [
            usageRow("openai/gpt-6-sol", "configured", 6),
            usageRow("openai/gpt-5.6-terra", "configured", 4),
          ],
          recent: [],
        },
      };
    /*
     * The trail: a run refused for its model by the person's teams, a team's models changed, and a
     * change to a person's role in that team. Narrowed by `eventType` as the server narrows it.
     */
    if (path === `${ORGANIZATION}/audit-events`) {
      this.auditQueries.push(url.search);
      const types = url.searchParams.get("eventType")?.split(",");
      const events = [
        {
          ...teamEvent("evt_3", "model.refused", {
            model: "openai/gpt-5.6-terra",
            source: "configured",
            rule: "team",
          }),
          targetType: "agent",
          targetId: "atlas",
          payload: {
            model: "openai/gpt-5.6-terra",
            source: "configured",
            rule: "team",
            teams: [
              { id: "team_sales", name: "Sales" },
              {
                id: "team_success",
                name: "Customer Success and Renewals, North America",
              },
            ],
          },
        },
        teamEvent("evt_2", "team.models_changed", {
          before: ["openai/gpt-6-sol"],
          after: ["openai/gpt-6-sol", "openai/gpt-5.6-terra"],
        }),
        teamEvent("evt_1", "team.member_role_changed", {
          person: SAM.email,
          role: "maintainer",
        }),
        // More than a phone shows at once, so the rows have to scroll.
        ...Array.from({ length: 10 }, (_, index) =>
          teamEvent(`evt_older_${index}`, "team.member_added", {
            person: SAM.email,
            role: "member",
          }),
        ),
      ].filter((event) => !types || types.includes(event.eventType));
      return {
        status: 200,
        json: { auditEvents: events, nextCursor: null },
      };
    }
    // The admin's settings: the organization's allowlist, no switches set, no network policies.
    if (path === SETTINGS_PATH)
      return {
        status: 200,
        json: settingsBody({
          settings: { modelAllowlist: ALLOWLIST },
          builtInModel: "openai/gpt-5.6-terra",
        }),
      };
    if (path === CAPABILITIES_PATH)
      return { status: 200, json: { capabilities: [], nextCursor: null } };
    if (path === NETWORK_POLICIES_PATH)
      return { status: 200, json: { networkPolicies: [], nextCursor: null } };
    return { status: 404, json: { detail: "Not found." } };
  }
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "team-models-screens.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [marksPlugin],
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

/** A page at `path`, served by `world`, once `ready` says it is there to look at. */
async function open(
  world: World,
  path: string,
  engine: string,
  theme: Theme,
  window: Window,
  ready: (page: Page) => Promise<unknown>,
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
  await page.route(`${ORIGIN}/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, pathname.split("/").pop() ?? "");
    if (pathname.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (pathname.startsWith("/api/")) {
      const { status, json } = world.answer(route.request());
      return json === undefined
        ? route.fulfill({ status })
        : route.fulfill({ status, json });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en" class="${theme}" style="color-scheme: ${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  await ready(page);
  await restyle(page);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Styles what the page draws now: a click drew something the last stylesheet was not built for. */
async function restyle(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  // Rows ease in and a dialog scales up: looked at once they are still.
  await page.waitForTimeout(400);
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
        getComputedStyle(element).visibility !== "hidden" &&
        rect.bottom > 0 &&
        rect.top < innerHeight
      );
    };
    const dialog = document.querySelector("[data-slot=dialog-content]");
    const scope: Element = dialog ?? document.body;
    const cut = [
      ...scope.querySelectorAll(
        "button, a, input, [role=checkbox], [role=switch]",
      ),
    ]
      .filter(shown)
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      /*
       * Not a control inside a strip that scrolls sideways on purpose (Activity's views, its table):
       * it is reached by scrolling the strip, and the page itself still never scrolls sideways.
       */
      .filter((control) => {
        for (
          let box = control.parentElement;
          box && box !== document.body;
          box = box.parentElement
        ) {
          const overflow = getComputedStyle(box).overflowX;
          if (
            (overflow === "auto" || overflow === "scroll") &&
            box.scrollWidth > box.clientWidth
          )
            return false;
        }
        return true;
      })
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    const overlapping: string[] = [];
    for (const row of scope.querySelectorAll("[data-slot=item]")) {
      if (!shown(row)) continue;
      const title = row.querySelector("[data-slot=item-title]");
      const actions = row.querySelector("[data-slot=item-actions]");
      if (!title || !actions) continue;
      const words = title.getBoundingClientRect();
      const buttons = actions.getBoundingClientRect();
      const apart =
        words.right <= buttons.left + 0.5 ||
        buttons.right <= words.left + 0.5 ||
        words.bottom <= buttons.top + 0.5 ||
        buttons.bottom <= words.top + 0.5;
      if (!apart) overlapping.push(title.textContent?.trim() ?? "");
      const card = row.getBoundingClientRect();
      if (buttons.right > card.right + 0.5 || buttons.left < card.left - 0.5)
        overlapping.push(`${title.textContent?.trim()} (outside its row)`);
    }
    const box = dialog?.getBoundingClientRect();
    return {
      sideways:
        document.documentElement.scrollWidth > innerWidth ||
        document.body.scrollWidth > innerWidth,
      cut,
      overlapping,
      dialogInside: box
        ? inside(box) && box.top >= 0 && box.bottom <= innerHeight + 0.5
        : true,
    };
  });
}

const FINE = { sideways: false, cut: [], overlapping: [], dialogInside: true };

/** Looks at what the page shows now: saved when screenshots are asked for, and held to FINE. */
async function look(page: Page, name: string) {
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${name}.png`) });
  }
  expect(await measured(page)).toEqual(FINE);
}

/** The Models row's words: its title and what it says the team runs. */
const modelsRow = (page: Page) =>
  page.locator("[data-slot=item]").filter({ hasText: /^Models/ });

describe.skipIf(!asked)("a team's models", () => {
  for (const engine of engines)
    for (const theme of THEMES)
      for (const window of [WIDE, PHONE]) {
        const tag = `${engine}-${theme}-${window.width}`;

        test(`an admin gives a team one model, then everything again, in ${tag}`, async () => {
          const world = new World("admin");
          const page = await open(
            world,
            "/admin/teams/team_sales",
            engine,
            theme,
            window,
            (one) =>
              one.getByText("Everything the organization allows").waitFor(),
          );
          try {
            await look(page, `team-page-admin-${tag}`);

            await modelsRow(page).click();
            const dialog = page.getByRole("dialog", {
              name: "Models for Sales",
            });
            await dialog
              .getByRole("checkbox", { name: "Allow GPT-6 Sol" })
              .waitFor();
            await restyle(page);
            // Only what the organization allows is offered.
            expect(
              await dialog
                .getByRole("checkbox")
                .evaluateAll((boxes) =>
                  boxes.map((box) => box.getAttribute("aria-label")),
                ),
            ).toEqual(["Allow GPT-6 Sol", "Allow GPT-5.6 Terra"]);
            await look(page, `team-models-dialog-${tag}`);

            await dialog
              .getByRole("checkbox", { name: "Allow GPT-6 Sol" })
              .click();
            await dialog.getByRole("button", { name: "Save" }).click();
            await dialog.waitFor({ state: "detached" });
            await modelsRow(page).getByText("GPT-6 Sol").waitFor();
            await restyle(page);
            expect(world.writes).toEqual([
              {
                method: "PUT",
                path: `${ORGANIZATION}/teams/team_sales/models`,
                body: { models: ["openai/gpt-6-sol"] },
              },
            ]);
            await look(page, `team-page-admin-one-model-${tag}`);

            // Reopened: the saved model is ticked, and the team can be given everything again.
            await modelsRow(page).click();
            await dialog
              .getByRole("button", {
                name: "Use everything the organization allows",
              })
              .waitFor();
            await restyle(page);
            await look(page, `team-models-dialog-saved-${tag}`);
            // It reads as a button, edged like Cancel beside it, never as a line of plain text.
            const clearButton = dialog.getByRole("button", {
              name: "Use everything the organization allows",
            });
            const edge = (button: typeof clearButton) =>
              button.evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                  width: style.borderTopWidth,
                  color: style.borderTopColor,
                };
              });
            const clearEdge = await edge(clearButton);
            expect(clearEdge.width).not.toBe("0px");
            expect(clearEdge).toEqual(
              await edge(dialog.getByRole("button", { name: "Cancel" })),
            );
            // Model names only: the id a run sends is nobody's to read in the dialog.
            expect(await dialog.textContent()).not.toContain("openai/");
            await dialog
              .getByRole("button", {
                name: "Use everything the organization allows",
              })
              .click();
            await dialog.waitFor({ state: "detached" });
            await modelsRow(page)
              .getByText("Everything the organization allows")
              .waitFor();
            expect(world.writes.at(-1)).toMatchObject({ method: "DELETE" });
            expect(world.lists.team_sales).toBeUndefined();
          } finally {
            await page.close();
          }
        }, 90_000);

        test(`a model the organization no longer allows shows greyed with why, in ${tag}`, async () => {
          const world = new World("admin", {
            team_sales: ["openai/gpt-6-sol", "openai/gpt-4o"],
          });
          const page = await open(
            world,
            "/admin/teams/team_sales",
            engine,
            theme,
            window,
            (one) =>
              one.getByText("2 models. One is no longer allowed.").waitFor(),
          );
          try {
            await modelsRow(page).click();
            await page
              .getByText(
                "The organization no longer allows it, so nobody runs it.",
                {
                  exact: false,
                },
              )
              .waitFor();
            await restyle(page);
            await look(page, `team-models-dialog-withdrawn-${tag}`);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`a member reads a team's models with nothing to press, in ${tag}`, async () => {
          const world = new World("member", {
            team_sales: ["openai/gpt-5.6-terra"],
          });
          const page = await open(
            world,
            "/teams/team_sales",
            engine,
            theme,
            window,
            (one) => modelsRow(one).getByText("GPT-5.6 Terra").waitFor(),
          );
          try {
            expect(
              await modelsRow(page).evaluate((row) => row.tagName),
            ).not.toBe("BUTTON");
            expect(
              await modelsRow(page)
                .locator("svg.tabler-icon-chevron-right")
                .count(),
            ).toBe(0);
            await look(page, `team-page-member-${tag}`);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`Activity names the team and its models before and after, in ${tag}`, async () => {
          const world = new World("admin");
          const page = await open(
            world,
            "/admin/audit",
            engine,
            theme,
            window,
            (one) => one.getByText("Change a team's models").waitFor(),
          );
          try {
            const row = page
              .getByRole("row")
              .filter({ hasText: "Change a team's models" });
            await row.getByText("Now: GPT-6 Sol, GPT-5.6 Terra").waitFor();
            await restyle(page);
            expect(await row.textContent()).toContain("Sales");
            expect(await row.textContent()).toContain("Before: GPT-6 Sol");
            // The other team events name their team too.
            expect(
              await page
                .getByRole("row")
                .filter({ hasText: "Change a person's role in a team" })
                .textContent(),
            ).toContain("Sales");
            // A run refused for its model reads as Blocked, saying whose list left it out.
            const refused = page
              .getByRole("row")
              .filter({ hasText: "Use a model" });
            expect(await refused.textContent()).toContain("Blocked");
            expect(await refused.textContent()).toContain(
              "GPT-5.6 Terra isn't on Sales' or Customer Success and Renewals, North America's list.",
            );
            // The decision and its lines are on screen at every width, never past the edge.
            for (const words of [
              "Now: GPT-6 Sol, GPT-5.6 Terra",
              "GPT-5.6 Terra isn't on Sales' or Customer Success and Renewals, North America's list.",
            ]) {
              const box = await page.getByText(words).boundingBox();
              expect(box).not.toBeNull();
              expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
                window.width,
              );
            }
            /*
             * The rows scroll with the page at every width, every one whole, the recording controls
             * after the last: in a box of their own, a phone showed two at a time and a laptop six,
             * the last cut mid-line.
             */
            const log = await page
              .locator("[data-slot=table-container]")
              .evaluate((element) => ({
                scroll: element.scrollHeight,
                client: element.clientHeight,
              }));
            expect(log.scroll).toBeLessThanOrEqual(log.client + 1);
            await page.getByText("Recording and export").waitFor();
            await look(page, `activity-team-models-${tag}`);

            // The Blocked view asks the server for refusals, a model's among them.
            await page.getByRole("button", { name: "Blocked" }).click();
            await page
              .getByRole("row")
              .filter({ hasText: "Use a model" })
              .waitFor();
            expect(world.auditQueries.at(-1)).toContain("model.refused");
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`the organization's Allowed models dialog keeps its box for another model, in ${tag}`, async () => {
          const world = new World("admin");
          const page = await open(
            world,
            "/admin/providers",
            engine,
            theme,
            window,
            (one) =>
              one.getByRole("button", { name: /^Allowed models/ }).waitFor(),
          );
          try {
            await page.getByRole("button", { name: /^Allowed models/ }).click();
            const dialog = page.getByRole("dialog", { name: "Allowed models" });
            await dialog
              .getByRole("checkbox", { name: "Allow GPT-6 Sol" })
              .waitFor();
            await restyle(page);
            /*
             * As the dialog opens, without scrolling anything: the search above the list and the
             * box for another model under it, both whole inside the dialog and above its buttons.
             * Only the list scrolls. Inside the scroll, a long list on a phone took the box for
             * another model out of sight.
             */
            const placed = await dialog.evaluate((content) => {
              const frame = content.getBoundingClientRect();
              const footer = content
                .querySelector("[data-slot=dialog-footer]")
                ?.getBoundingClientRect();
              const seen = (label: string) => {
                const input = content.querySelector(
                  `input[aria-label="${label}"]`,
                );
                const box = input?.getBoundingClientRect();
                return box
                  ? box.height > 20 &&
                      box.top >= frame.top - 0.5 &&
                      box.bottom <= (footer?.top ?? frame.bottom) + 0.5 &&
                      box.bottom <= innerHeight
                  : false;
              };
              const list = content.querySelector("[data-slot=dialog-body]");
              return {
                search: seen("Search models"),
                another: seen("Another model"),
                listScrolls: list
                  ? list.scrollHeight > list.clientHeight
                  : false,
              };
            });
            expect(placed).toEqual({
              search: true,
              another: true,
              listScrolls: true,
            });
            await look(page, `allowed-models-dialog-other-${tag}`);
          } finally {
            await page.close();
          }
        }, 60_000);

        test(`Admin, Providers names the teams with their own list, in ${tag}`, async () => {
          const world = new World("admin", {
            team_sales: ["openai/gpt-6-sol"],
            team_success: ["openai/gpt-5.6-terra"],
          });
          const page = await open(
            world,
            "/admin/providers",
            engine,
            theme,
            window,
            (one) => one.getByText("Teams with their own list").waitFor(),
          );
          try {
            const line = page
              .locator("[data-slot=item]")
              .filter({ hasText: "Teams with their own list" });
            await line.scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            expect(
              await line
                .getByRole("link")
                .evaluateAll((links) =>
                  links.map((link) => [
                    link.textContent,
                    link.getAttribute("href"),
                  ]),
                ),
            ).toEqual([
              ["Sales", "/admin/teams/team_sales"],
              [
                "Customer Success and Renewals, North America",
                "/admin/teams/team_success",
              ],
            ]);
            await look(page, `providers-teams-line-${tag}`);
            // Allowed models and Usage name each model as the team's page does, never by its id.
            await page.getByText("GPT-6 Sol, GPT-5.6 Terra").waitFor();
            const usage = page
              .locator("section")
              .filter({ has: page.getByRole("heading", { name: "Usage" }) });
            await usage.scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            expect(
              await usage
                .locator("[data-slot=item-title]")
                .evaluateAll((titles) => titles.map((one) => one.textContent)),
            ).toEqual(["GPT-6 Sol", "GPT-5.6 Terra"]);
            expect(await page.locator("body").innerText()).not.toContain(
              "openai/",
            );
            await look(page, `providers-usage-${tag}`);
            await line.getByRole("link", { name: "Sales" }).click();
            await page.getByText("GPT-6 Sol").waitFor();
            expect(new URL(page.url()).pathname).toBe(
              "/admin/teams/team_sales",
            );
          } finally {
            await page.close();
          }
        }, 60_000);
      }
});
