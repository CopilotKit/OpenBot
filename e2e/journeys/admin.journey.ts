import type { Locator } from "@playwright/test";
import { expect, type Page, test } from "../harness/test";

/**
 * ADMIN, in the personal edition: every page of it, opened the way a person does, each loading
 * what it shows.
 *
 * Admin is in every edition. In the personal edition the one person is its admin (single-user mode
 * signs them in as one), so the entry is in the menu under their name, beside OpenBot for Business,
 * and every Admin address opens where it is. A page or section that sets something only a team has
 * (who signs in, people and roles, permissions, team approval rules, the settings the personal
 * edition fixes) keeps its place and says it applies when OpenBot runs for a team.
 *
 * Every API request a page makes must succeed: an Admin page that asked for something the
 * personal edition has no API for would show an error, which is what this journey exists to catch.
 * It changes nothing.
 */

const PERSON = "Sam Rivera";
const FOR_A_TEAM = "This applies when OpenBot runs for a team.";

/** Every API request that failed while the journey ran. */
function failedRequests(page: Page): string[] {
  const failed: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/") && response.status() >= 400)
      failed.push(
        `${response.status()} ${response.request().method()} ${url.pathname}`,
      );
  });
  return failed;
}

/** One entry of Admin's sidebar, then the page's own heading. */
async function openAdminPage(page: Page, link: string, heading = link) {
  await page
    .locator('[data-sidebar="sidebar"]')
    .first()
    .getByRole("link", { name: link, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: heading, level: 1 }),
  ).toBeVisible();
}

/** The "For a team" box, in a section called `section` or, without one, on the page itself. */
async function expectForATeam(main: Locator, section?: string) {
  const scope = section
    ? main.locator("section").filter({
        has: main.page().getByRole("heading", { name: section, level: 2 }),
      })
    : main;
  const box = scope.getByText(FOR_A_TEAM);
  await expect(box).toBeVisible();
  await box.scrollIntoViewIfNeeded();
  await expect(scope.getByText("For a team", { exact: true })).toBeVisible();
  await expect(
    scope.getByRole("button", { name: /Meet OpenBot for Business/ }),
  ).toBeVisible();
}

/** Nothing on the page says it failed. */
async function expectNoError(main: Locator) {
  await expect(main.getByRole("alert")).toHaveCount(0);
  await expect(main.getByText(/Couldn't load|Could not load/)).toHaveCount(0);
}

test("the personal edition's one person opens Admin and every page in it loads", async ({
  page,
  shot,
}) => {
  test.setTimeout(240_000);
  const failed = failedRequests(page);
  const main = page.getByRole("main");

  await test.step("Admin is in the menu under the person's name, beside OpenBot for Business", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: PERSON }).click();
    const menu = page.getByRole("menu");
    await expect(
      menu.getByRole("menuitem", { name: "OpenBot for Business" }),
    ).toBeVisible();
    await shot("menu");
    await menu.getByRole("menuitem", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { name: "Admin", level: 1 }),
    ).toBeVisible();
    for (const section of [
      "Routines",
      "Skills",
      "Apps",
      "Computer",
      "Approvals",
      "Activity",
      "Vault",
      "Team",
    ])
      await expect(
        main.getByRole("heading", { name: section, level: 2 }),
      ).toBeVisible();
    await shot("overview");
  });

  await test.step("Routines: how check-ins went, and the switch for a team", async () => {
    await openAdminPage(page, "Routines");
    await expect(
      main.getByRole("heading", { name: "How check-ins went", level: 2 }),
    ).toBeVisible();
    // The person's own numbers, read from the server.
    await expect(main.getByText("Pings sent")).toBeVisible();
    await expectForATeam(main, "Check-ins");
    await expectNoError(main);
    await shot("routines");
  });

  await test.step("Skills, and writing one", async () => {
    await openAdminPage(page, "Skills");
    for (const name of ["Find a document", "Make a Bot", "Write a skill"])
      await expect(
        main.getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toBeVisible();
    await expectNoError(main);
    await shot("skills");
    await page.goto("/admin/skills/new");
    await expect(
      page.getByRole("heading", { name: "New skill", level: 1 }),
    ).toBeVisible();
    await expect(main.getByRole("textbox", { name: "Title" })).toBeVisible();
    await expectNoError(main);
    await shot("skills-new");
  });

  await test.step("Automatic learning: for a team, with the person's own on Skills", async () => {
    await page.goto("/admin");
    await openAdminPage(page, "Automatic learning");
    await expectForATeam(main);
    await expect(main.getByRole("link", { name: "Skills" })).toHaveAttribute(
      "href",
      "/skills",
    );
    await shot("learning");
  });

  await test.step("Apps: what is connected and what can be added", async () => {
    await openAdminPage(page, "Apps");
    await expect(
      main.getByRole("heading", { name: "Connected", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText("Parallel Search").first()).toBeVisible();
    await expectNoError(main);
    await shot("apps");
    await expectForATeam(main, "MCP servers");
    await shot("apps-mcp-servers");
  });

  await test.step("UI components and the Playground", async () => {
    await openAdminPage(page, "UI components");
    await expect(main.getByText("Checklist", { exact: true })).toBeVisible();
    await expectNoError(main);
    await shot("components");
    await openAdminPage(page, "Playground");
    await expect(main.getByText("A worked example")).toBeVisible();
    await expectNoError(main);
    await shot("playground");
  });

  await test.step("Computers: the one computer, and the fleet settings for a team", async () => {
    await openAdminPage(page, "Computers", "Computer");
    for (const section of ["Folders on this computer", "Your Bots' browsers"])
      await expect(
        main.getByRole("heading", { name: section, level: 2 }),
      ).toBeVisible();
    // Read from the server: no desktop runs this stack, and the Bots' browsers, or that there are none.
    await expect(main.getByText("Needs OpenBot Desktop")).toBeVisible();
    await expect(
      main
        .getByText("No browsers yet")
        .or(main.getByRole("button", { name: "Reset" }))
        .first(),
    ).toBeVisible();
    await expectNoError(main);
    await shot("computers");
    await expectForATeam(main, "Idle computers");
    await expectForATeam(main, "Network");
    await shot("computers-for-a-team");
  });

  await test.step("Approvals: for a team, with the person's own in Settings", async () => {
    await openAdminPage(page, "Approvals");
    await expectForATeam(main);
    await expect(
      main.getByRole("link", { name: "Settings → Approvals" }),
    ).toHaveAttribute("href", "/settings/approvals");
    await shot("approvals");
    for (const [path, heading] of [
      ["/admin/approvals/describe", "Describe team rules"],
      ["/admin/approvals/guidance", "Guidance for auto-review"],
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: heading, level: 1 }),
      ).toBeVisible();
      await expectForATeam(main);
      await shot(path.split("/").at(-1) ?? path);
    }
  });

  await test.step("Boundaries, and adding one", async () => {
    await page.goto("/admin");
    await openAdminPage(page, "Boundaries");
    await expect(
      main.getByRole("heading", { name: "Bots may never", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText("Trial mode")).toBeVisible();
    await expectNoError(main);
    await shot("boundaries");
    await page.goto("/admin/boundaries/new");
    await expect(
      page.getByRole("heading", { name: "Add rule", level: 1 }),
    ).toBeVisible();
    await expect(main.getByText("Describe it in words")).toBeVisible();
    await expectNoError(main);
    await shot("boundaries-new");
  });

  await test.step("What would happen", async () => {
    await page.goto("/admin");
    await openAdminPage(page, "What would happen");
    await expect(
      main.getByRole("heading", { name: "The action", level: 2 }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: /^Bot:/ })).toBeVisible();
    await expectNoError(main);
    await shot("what-if");
  });

  await test.step("Activity: the trail, and recording for a team", async () => {
    await openAdminPage(page, "Activity");
    // What the person did on the way here: the model key they saved.
    await expect(main.getByText("Save a credential").first()).toBeVisible();
    await expectNoError(main);
    await shot("activity");
    await expectForATeam(main, "Recording and export");
    await shot("activity-recording");
  });

  await test.step("Vault, and adding a key", async () => {
    await openAdminPage(page, "Vault");
    await expect(
      main.getByRole("heading", { name: "Saved keys", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText("openai", { exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Add key" })).toBeVisible();
    await expectNoError(main);
    await shot("vault");
    await page.goto("/admin/credentials/new");
    await expect(
      page.getByRole("heading", { name: "Add key", level: 1 }),
    ).toBeVisible();
    await expectNoError(main);
    await shot("vault-new");
  });

  await test.step("People, Permissions and Identity providers: for a team", async () => {
    await page.goto("/admin");
    await openAdminPage(page, "People");
    await expectForATeam(main);
    await shot("people");
    await openAdminPage(page, "Permissions");
    await expectForATeam(main);
    await shot("permissions");
    await page.goto("/admin/permissions/describe");
    await expect(
      page.getByRole("heading", { name: "Describe who can do what", level: 1 }),
    ).toBeVisible();
    await expectForATeam(main);
    await shot("permissions-describe");
    await page.goto("/admin");
    await openAdminPage(page, "Identity providers");
    await expectForATeam(main);
    await shot("identity-providers");
  });

  await test.step("Providers: who serves the models, and what the Bots ran on", async () => {
    await openAdminPage(page, "Providers");
    await expect(
      main.getByRole("heading", { name: "Connected", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText("Every listed model")).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Usage", level: 2 }),
    ).toBeVisible();
    // The runs the person's Bots made, or that there were none: read either way, never an error.
    await expect(
      main
        .getByText(/ runs? by 1 person/)
        .or(main.getByText("No recent runs"))
        .first(),
    ).toBeVisible();
    await expectNoError(main);
    await shot("providers");
  });

  expect(failed, "every API request Admin made succeeded").toEqual([]);
});
