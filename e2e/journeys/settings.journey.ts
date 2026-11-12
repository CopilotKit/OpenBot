import { readFileSync } from "node:fs";
import { expect, type Page, test } from "../harness/test";

/**
 * SETTINGS, every screen of it and what a person can do on each, in the personal edition: General,
 * Notifications, the Vault, Computer, Approvals, Activity, Setup and the Components gallery.
 *
 * Each test puts back what it changed. A person's name, their standing instructions and their rules
 * reach every Bot, so a journey that left them changed would change what the next one asks a model.
 *
 * Share usage data is OpenBot Desktop's: the desktop app sends usage data and keeps the choice, so the
 * web app draws no Privacy section at all (`components/settings/usage-data.tsx`). This checks the web
 * app leaves it out; the switch itself is driven in the desktop slices.
 */

const PERSON = "Sam Rivera";

/** Settings, the way a person opens it: their name at the foot of the sidebar, then Settings. */
async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: PERSON }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(
    page.getByRole("heading", { name: "General", level: 1 }),
  ).toBeVisible();
}

/** One entry of the Settings sidebar. */
async function openSection(page: Page, name: string) {
  await page
    .getByRole("complementary")
    .or(page.locator('[data-sidebar="sidebar"]'))
    .first()
    .getByRole("link", { name, exact: true })
    .click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("General: a person's name, standing instructions, theme, skin, sidebar emphasis and shortcuts", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await shot("general");

  await test.step("no Privacy section outside OpenBot Desktop", async () => {
    await expect(main.getByRole("heading", { name: "Privacy" })).toHaveCount(0);
    await expect(
      main.getByRole("switch", { name: "Share usage data" }),
    ).toHaveCount(0);
  });

  await test.step("change the name, then put it back", async () => {
    await main.getByRole("button", { name: `Name ${PERSON}` }).click();
    const dialog = page.getByRole("dialog", { name: "Your name" });
    const field = dialog.getByRole("textbox", { name: "Name" });
    await expect(field).toHaveValue(PERSON);
    await field.fill("");
    await expect(
      dialog.getByRole("button", { name: "Save name" }),
    ).toBeDisabled();
    await field.fill("Sam Okafor");
    await shot("name-dialog");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: "Name Sam Okafor" }),
    ).toBeVisible();
    await shot("name-changed");

    await main.getByRole("button", { name: "Name Sam Okafor" }).click();
    await dialog.getByRole("textbox", { name: "Name" }).fill(PERSON);
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: `Name ${PERSON}` }),
    ).toBeVisible();
  });

  await test.step("standing instructions: write them, then clear them", async () => {
    const instructions =
      "Keep answers under five sentences and write in British English.";
    await main.getByRole("button", { name: /^Standing instructions/ }).click();
    const dialog = page.getByRole("dialog", { name: "Standing instructions" });
    const box = dialog.getByRole("textbox", { name: "Standing instructions" });
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await box.fill(instructions);
    await expect(
      dialog.getByText(`${instructions.length} of 4000 characters`),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Saved")).toBeVisible();
    await shot("standing-instructions");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(
      main.getByRole("button", {
        name: `Standing instructions ${instructions}`,
      }),
    ).toBeVisible();

    await main.getByRole("button", { name: /^Standing instructions/ }).click();
    await box.fill("");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Saved")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(
      main.getByRole("button", {
        name: "Standing instructions None yet. Tell every Bot how you want things done.",
      }),
    ).toBeVisible();
  });

  await test.step("dark theme on and off", async () => {
    const dark = main.getByRole("switch", { name: "Dark theme" });
    await expect(dark).not.toBeChecked();
    await dark.click();
    await expect(dark).toBeChecked();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await shot("dark-theme");
    await dark.click();
    await expect(dark).not.toBeChecked();
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  });

  await test.step("another skin, seen in the app, then back to OpenBot", async () => {
    const skin = main.getByRole("combobox", { name: "Skin" });
    await expect(skin).toHaveText(/OpenBot/);
    await skin.click();
    await expect(page.getByRole("option", { name: /^OpenDuet/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /^OpenFuse/ })).toBeVisible();
    await page.getByRole("option", { name: /^OpenDots/ }).click();
    await expect(skin).toHaveText(/OpenDots/);
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(page.locator("html")).toHaveAttribute("data-skin", "opendots");
    await page.getByRole("link", { name: "Back to app" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-skin", "opendots");
    await shot("skin-opendots");

    await page.goto("/settings");
    await main.getByRole("combobox", { name: "Skin" }).click();
    await page.getByRole("option", { name: /^OpenBot/ }).click();
    await expect(main.getByRole("combobox", { name: "Skin" })).toHaveText(
      /OpenBot/,
    );
    // Choosing closes the menu.
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-skin",
      "opendots",
    );
  });

  await test.step("the sidebar's emphasis, previewed, then put back", async () => {
    const emphasis = main.getByRole("combobox", {
      name: "Message list emphasis",
    });
    const preview = main.getByRole("figure", { name: "Message list preview" });
    await expect(emphasis).toHaveText(/Conversation title/);
    await emphasis.click();
    await page.getByRole("option", { name: "Bot name" }).click();
    await expect(emphasis).toHaveText(/Bot name/);
    await expect(preview).toBeVisible();
    await shot("emphasis-bot-name");
    await emphasis.click();
    await page.getByRole("option", { name: "Conversation title" }).click();
    await expect(emphasis).toHaveText(/Conversation title/);
  });

  await test.step("keyboard shortcuts are listed, and the command palette opens", async () => {
    await expect(
      main.getByRole("heading", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await expect(
      main.getByText("New conversation", { exact: true }),
    ).toBeVisible();
    await expect(
      main.getByText("Command palette", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await shot("command-palette");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
});

test("Notifications: where updates go, devices and deliveries", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Notifications");
  await expect(
    main.getByRole("heading", { name: "Where updates go" }),
  ).toBeVisible();
  await expect(main.getByText("Updates stay in OpenBot")).toBeVisible();
  await expect(
    main.getByRole("link", { name: "How to set them up" }),
  ).toHaveAttribute("href", /docs\/configuration\.md/);
  await expect(
    main.getByRole("heading", { name: "Your devices" }),
  ).toBeVisible();
  await expect(main.getByText("No devices yet")).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "Recent deliveries" }),
  ).toBeVisible();
  await expect(main.getByText("No deliveries yet")).toBeVisible();
  await shot("notifications");
});

test("Vault: add a key, replace it, revoke it, and no saved logins", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const PROVIDER = "github";
  const KEY_ID = "e2e-personal-token";
  const rows = main.locator('[data-slot="item"]').filter({
    hasText: `connector · ${KEY_ID}`,
  });

  await openSettings(page);
  await openSection(page, "Vault");
  await expect(main.getByText("No saved logins yet")).toBeVisible();
  await expect(main.getByText("model · openai-api-key · active")).toBeVisible();
  await shot("vault");

  await test.step("Add key: what's missing is said, then a connector key is saved", async () => {
    await main.getByRole("button", { name: "Add key" }).click();
    await expect(
      page.getByRole("heading", { name: "Add key", level: 1 }),
    ).toBeVisible();
    // A connector's key is named by the person: a provider and a key ID, besides the secret.
    await main.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Connector" }).click();
    await expect(main.getByRole("textbox", { name: "Key ID" })).toBeVisible();
    await main.getByRole("button", { name: "Save credential" }).click();
    await expect(
      main.getByRole("textbox", { name: "Provider" }),
    ).toHaveAttribute("aria-invalid", "true");
    await shot("add-key-missing");

    await main.getByRole("textbox", { name: "Provider" }).fill(PROVIDER);
    await main.getByRole("textbox", { name: "Key ID" }).fill(KEY_ID);
    await main
      .getByRole("textbox", { name: "Secret" })
      .fill("e2e-not-a-real-token-1");
    await shot("add-key");
    await main.getByRole("button", { name: "Save credential" }).click();
    await expect(
      page.getByRole("heading", { name: "Vault", level: 1 }),
    ).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(PROVIDER);
    await expect(rows.first()).toContainText(`connector · ${KEY_ID} · active`);
  });

  await test.step("replace it: saving the same key says it replaces the live one", async () => {
    await main.getByRole("button", { name: "Add key" }).click();
    await main.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Connector" }).click();
    await main.getByRole("textbox", { name: "Provider" }).fill(PROVIDER);
    await main.getByRole("textbox", { name: "Key ID" }).fill(KEY_ID);
    await expect(
      main.getByText(
        "This key already has an active credential. Saving replaces it and revokes the old one.",
      ),
    ).toBeVisible();
    await main
      .getByRole("textbox", { name: "Secret" })
      .fill("e2e-not-a-real-token-2");
    await shot("replace-key");
    await main.getByRole("button", { name: "Save credential" }).click();
    await expect(
      page.getByRole("heading", { name: "Vault", level: 1 }),
    ).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "· active" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "· revoked" })).toHaveCount(1);
    await shot("key-replaced");
  });

  await test.step("revoke it", async () => {
    const live = rows.filter({ hasText: "· active" });
    await live.getByRole("button", { name: "Revoke" }).click();
    await expect(rows.filter({ hasText: "· active" })).toHaveCount(0);
    await expect(rows.filter({ hasText: "· revoked" })).toHaveCount(2);
    for (const row of await rows.all()) {
      await expect(row.getByRole("button", { name: "Revoke" })).toBeDisabled();
    }
    // The model key the Personal Assistant uses is untouched.
    await expect(
      main.getByText("model · openai-api-key · active"),
    ).toBeVisible();
    await shot("key-revoked");
  });
});

test("Computer: the Bots' computer, their browsers and the Recorder", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Computer");
  await expect(
    main.getByRole("heading", { name: "Folders on this computer" }),
  ).toBeVisible();
  // Folders are OpenBot Desktop's to share; the web app says where to do it.
  await expect(main.getByText("Needs OpenBot Desktop")).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "Your Bots' browsers" }),
  ).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "What the Recorder collects" }),
  ).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "This browser" }),
  ).toBeVisible();
  await expect(
    main.getByText("The OpenBot Recorder isn't installed in this browser."),
  ).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "Connected browsers" }),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "Activity" })).toHaveAttribute(
    "href",
    "/settings/activity",
  );
  await shot("computer");
});

test("Approvals: ask-first switches, commands, and a rule for every Bot", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Approvals");
  await shot("approvals");

  await test.step("Extra vigilant and Auto-review switch on and off", async () => {
    for (const name of ["Extra vigilant", "Auto-review"]) {
      const toggle = main.getByRole("switch", { name });
      const was = await toggle.isChecked();
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: !was });
      await page.reload();
      await expect(main.getByRole("switch", { name })).toBeChecked({
        checked: !was,
      });
      await main.getByRole("switch", { name }).click();
      await expect(main.getByRole("switch", { name })).toBeChecked({
        checked: was,
      });
    }
  });

  await test.step("commands on this computer", async () => {
    const commands = main.getByRole("combobox", {
      name: "Commands on your computer",
    });
    await expect(commands).toHaveText(/Ask every time/);
    await commands.click();
    await expect(page.getByRole("option", { name: "Never" })).toBeVisible();
    await page.getByRole("option", { name: "Always allow" }).click();
    await expect(commands).toHaveText(/Always allow/);
    await page.reload();
    await expect(
      main.getByRole("combobox", { name: "Commands on your computer" }),
    ).toHaveText(/Always allow/);
    await main
      .getByRole("combobox", { name: "Commands on your computer" })
      .click();
    await page.getByRole("option", { name: "Ask every time" }).click();
    await expect(
      main.getByRole("combobox", { name: "Commands on your computer" }),
    ).toHaveText(/Ask every time/);
  });

  await test.step("add a rule, change what it does, and remove it", async () => {
    await expect(main.getByText("No rules yet")).toBeVisible();
    await main.getByRole("button", { name: /^Add a rule/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add a rule" });
    await expect(
      dialog.getByRole("button", { name: "Save rule" }),
    ).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: "Tool or app" })
      .fill("composio-gmail/*");
    await dialog.getByRole("textbox", { name: "Kind of action" }).fill("write");
    await expect(dialog.getByRole("textbox", { name: "Target" })).toHaveValue(
      "*",
    );
    await expect(
      dialog.getByRole("combobox", { name: "Behaviour" }),
    ).toHaveText(/Ask before taking action/);
    await shot("add-rule");
    await dialog.getByRole("button", { name: "Save rule" }).click();
    await expect(dialog).toBeHidden();
    // A rule is listed in words: composio-gmail/* with write is any change on Gmail.
    const behaviour = main.getByRole("combobox", {
      name: "Behaviour for Any action on Gmail",
    });
    const rule = main.locator('[data-slot="item"]').filter({
      has: page.getByRole("combobox", {
        name: "Behaviour for Any action on Gmail",
      }),
    });
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText("Any action on Gmail");
    await shot("rule-added");

    await behaviour.click();
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    const choices = await options.allTextContents();
    const other = choices.find(
      (choice) => !/Ask before taking action/.test(choice),
    );
    expect(other, "a rule can do something other than ask").toBeTruthy();
    await page
      .getByRole("option", { name: other as string, exact: true })
      .click();
    await expect(behaviour).toHaveText(
      new RegExp(escapeRegExp(other as string)),
    );
    await shot("rule-changed");

    await rule.getByRole("button", { name: "Remove" }).click();
    await expect(rule).toHaveCount(0);
    await expect(main.getByText("No rules yet")).toBeVisible();
  });
});

test("Activity: views, search, sort, refresh and a CSV export", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Activity");
  const table = main.getByRole("table");
  // The core loop saved the Personal Assistant's key, so the trail has at least that.
  const saved = table.getByRole("row").filter({ hasText: "Save a credential" });
  await expect(saved.first()).toBeVisible();
  await shot("activity");

  await test.step("views", async () => {
    const views = main.getByRole("group", { name: "View" });
    for (const name of [
      "Computer actions",
      "Blocked",
      "Did not happen",
      "Nobody watching",
      "Everything",
    ]) {
      await views.getByRole("button", { name }).click();
      await expect(views.getByRole("button", { name })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    await expect(saved.first()).toBeVisible();
  });

  await test.step("search", async () => {
    const search = main.getByRole("searchbox", { name: "Search events" });
    await search.fill("openai-api-key");
    // Search covers the events loaded, the newest 50 at first. After journeys that make a lot of
    // events (a Bot browsing does), the core loop's key is further back: load older ones until it is.
    const older = main.getByRole("button", { name: "Show older events" });
    await expect(async () => {
      if ((await saved.count()) === 0 && (await older.isVisible()))
        await older.click();
      await expect(saved.first()).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(
      table.getByRole("row").filter({ hasText: "Turn on an app" }),
    ).toHaveCount(0);
    await shot("activity-search");
    await search.fill("");
  });

  await test.step("sort oldest first and back", async () => {
    const when = main.getByRole("button", { name: /^When/ });
    await expect(when).toHaveAccessibleName(/newest first/);
    await when.click();
    await expect(
      main.getByRole("button", { name: /^When/ }),
    ).toHaveAccessibleName(/oldest first/);
    await main.getByRole("button", { name: /^When/ }).click();
    await expect(
      main.getByRole("button", { name: /^When/ }),
    ).toHaveAccessibleName(/newest first/);
  });

  await test.step("filters open", async () => {
    for (const name of ["Outcome", "Bot", "Started by"]) {
      await main.getByRole("button", { name, exact: true }).click();
      await expect(
        page
          .getByRole("menu")
          .or(page.getByRole("dialog"))
          .or(page.getByRole("listbox"))
          .first(),
      ).toBeVisible();
      await shot(`activity-filter-${name.toLowerCase().replace(/\s+/g, "-")}`);
      await page.keyboard.press("Escape");
    }
  });

  await test.step("refresh and export", async () => {
    await main.getByRole("button", { name: "Refresh" }).click();
    await expect(saved.first()).toBeVisible();
    const download = page.waitForEvent("download");
    await main.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const csv = readFileSync(await file.path(), "utf8");
    expect(csv.split("\n")[0].length).toBeGreaterThan(0);
    expect(csv).toContain("openai-api-key");
  });
});

test("Setup: what's ready, and Check again", async ({ page, shot }) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Setup");
  const rows = main.getByRole("list", { name: "Setup" }).getByRole("listitem");
  await expect(rows.filter({ hasText: "Backend" })).toContainText("Ready");
  await expect(rows.filter({ hasText: "Bot computer" })).toContainText("Ready");
  // Composio's API, which the run's stub answers, is what makes more apps ready.
  await expect(rows.filter({ hasText: "More apps" })).toContainText("Ready");
  // The model key is set; whether it was checked depends on what ran before, until Check again.
  await expect(rows.filter({ hasText: "AI model" })).toContainText(
    "The key is set",
  );
  await shot("setup");
  await main.getByRole("button", { name: "Check again" }).click();
  await expect(main.getByRole("button", { name: "Check again" })).toBeEnabled();
  // Behind aimock, a custom endpoint, the check can't vouch for the key and says so.
  await expect(rows.filter({ hasText: "AI model" })).toContainText(
    "The key is set. OpenBot can't check a custom endpoint.",
  );
  await expect(rows.filter({ hasText: "AI model" })).not.toContainText(
    "Needs setup",
  );
  await shot("setup-checked-again");
});

test("Components gallery: every component a Bot can draw, and one opened", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await openSettings(page);
  await openSection(page, "Components gallery");
  for (const name of [
    "Activity report",
    "Checklist",
    "Data table",
    "Headline figures",
    "Notice",
    "Quotation",
    "Record",
    "Area chart",
    "Bar chart",
    "Donut chart",
    "Line chart",
    "Progress against target",
    "Approval",
    "Choice",
    "Form",
  ]) {
    await expect(
      main.getByRole("heading", { name, level: 4, exact: true }),
    ).toBeVisible();
  }
  await shot("components-gallery");

  await main.getByRole("link", { name: /^Checklist/ }).click();
  await expect(
    page.getByRole("heading", { name: "Checklist", level: 1 }),
  ).toBeVisible();
  await expect(main.getByText("showChecklist")).toBeVisible();
  await shot("component-checklist");
  await main.getByRole("button", { name: "Components gallery" }).click();
  await expect(
    page.getByRole("heading", { name: "Components gallery", level: 1 }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Back to app" }).click();
  await expect(page).toHaveURL(/\/$/);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
