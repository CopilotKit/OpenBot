import { expect, test } from "../harness/test";
import { settingsRow } from "./computer-steps";

/**
 * APPROVALS, THE SETTINGS. Settings → Approvals: Extra vigilant, Auto-review and how commands on
 * this computer are handled, each kept across a reload; and rules for every Bot, added, changed and
 * removed. No Bot runs here.
 */

// The switches are the person's, for every Bot. Put back after the journey, even one that failed
// half way, so no journey after it meets an Extra vigilant it did not ask for.
test.afterEach(async ({ page }) => {
  await page.request.patch("/api/approvals/preferences", {
    data: { enabled: false, autoReview: false, hostCommands: "ask" },
  });
});

test("the Approvals settings: Extra vigilant, Auto-review, commands, and rules for every Bot", async ({
  page,
  shot,
}) => {
  await test.step("open Settings → Approvals", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sam Rivera" }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("link", { name: "Approvals" }).click();
    await expect(
      page.getByRole("heading", { name: "Approvals", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("No rules yet")).toBeVisible();
    await shot("approvals-settings");
  });

  const vigilant = page.getByRole("switch", { name: "Extra vigilant" });
  const review = page.getByRole("switch", { name: "Auto-review" });
  const commands = page.getByRole("combobox", {
    name: "Commands on your computer",
  });

  await test.step("switch Extra vigilant and Auto-review on, and they stay on", async () => {
    await expect(vigilant).not.toBeChecked();
    await expect(review).not.toBeChecked();
    await vigilant.click();
    await expect(vigilant).toBeChecked();
    await review.click();
    await expect(review).toBeChecked();
    await page.reload();
    await expect(vigilant).toBeChecked();
    await expect(review).toBeChecked();
    await shot("switched-on");
  });

  await test.step("choose how commands on this computer are handled", async () => {
    await expect(commands).toContainText("Ask every time");
    await commands.click();
    await page.getByRole("option", { name: "Never" }).click();
    await expect(commands).toContainText("Never");
    await page.reload();
    await expect(commands).toContainText("Never");
    await shot("commands-never");
  });

  await test.step("put them back", async () => {
    await vigilant.click();
    await expect(vigilant).not.toBeChecked();
    await review.click();
    await expect(review).not.toBeChecked();
    await commands.click();
    await page.getByRole("option", { name: "Ask every time" }).click();
    await expect(commands).toContainText("Ask every time");
    await page.reload();
    await expect(vigilant).not.toBeChecked();
    await expect(review).not.toBeChecked();
    await expect(commands).toContainText("Ask every time");
  });

  await test.step("add a rule for every Bot, change it, and remove it", async () => {
    await page.getByRole("button", { name: /^Add a rule/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add a rule" });
    await expect(dialog).toBeVisible();
    const save = dialog.getByRole("button", { name: "Save rule" });
    await expect(save).toBeDisabled();
    await dialog
      .getByRole("textbox", { name: "Tool or app" })
      .fill("computer_click");
    await dialog.getByRole("textbox", { name: "Kind of action" }).fill("*");
    await dialog
      .getByRole("textbox", { name: "Target" })
      .fill("*.fernhill.example");
    await dialog.getByRole("combobox", { name: "Behaviour" }).click();
    await page.getByRole("option", { name: "Hand off to you" }).click();
    await shot("add-rule");
    await save.click();
    await expect(dialog).toBeHidden();

    const rule = settingsRow(page, "*.fernhill.example");
    await expect(rule).toHaveCount(1);
    const behaviour = rule.getByRole("combobox", { name: /^Behaviour for / });
    await expect(behaviour).toContainText("Hand off to you");
    await expect(page.getByText("No rules yet")).toHaveCount(0);
    await shot("rule-added");

    await behaviour.click();
    await page
      .getByRole("option", { name: "Ask before taking action" })
      .click();
    await expect(behaviour).toContainText("Ask before taking action");
    await page.reload();
    await expect(
      settingsRow(page, "*.fernhill.example").getByRole("combobox", {
        name: /^Behaviour for /,
      }),
    ).toContainText("Ask before taking action");

    await settingsRow(page, "*.fernhill.example")
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(page.getByText("No rules yet")).toBeVisible();
    await shot("rule-removed");
  });

  await test.step("Cancel leaves a rule unsaved", async () => {
    await page.getByRole("button", { name: /^Add a rule/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add a rule" });
    await dialog
      .getByRole("textbox", { name: "Tool or app" })
      .fill("computer_type");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("No rules yet")).toBeVisible();
  });

  await test.step("the old Approvals address opens these settings", async () => {
    await page.goto("/approvals");
    await expect(page).toHaveURL(/\/settings\/approvals$/);
    await expect(
      page.getByRole("heading", { name: "Approvals", level: 1 }),
    ).toBeVisible();
  });
});
