import type { Page } from "@playwright/test";
import { SITE } from "../site/site";
import {
  activityRows,
  computerPanel,
  expect,
  expectScreenFillsFrame,
  expectWholeReply,
  named,
  newConversation,
  openComputer,
  replyAfter,
  send,
  serveSite,
  settingsRow,
  test,
  turnOver,
} from "./computer-steps";

/**
 * THE BOT'S COMPUTER, TAKEN OVER. After a Bot has browsed, the person opens its screen full size,
 * takes control, goes somewhere from the address bar, goes back, forward and reloads, opens a tab
 * and closes it, is asked before clearing the browser, and hands it back. Settings → Computer lists
 * the Bot's browser, which they stop and reset.
 */

serveSite();

/** The Bot's screen, opened full size over the conversation. */
const fullSize = (page: Page) =>
  page.getByRole("dialog", { name: "The Bot's screen" });

test("the person takes the Bot's browser over, browses, and hands it back", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(300_000);
  const botId = await makeBot(
    "Fernhill Guide",
    "Show me around garden shop websites. Keep answers to one sentence.",
  );
  let channelId = "";

  await test.step("the Bot opens a page", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Open ${SITE}/about and tell me who founded the shop, in one short sentence.`,
    );
    await turnOver(page);
    const reply = await replyAfter(page, channelId, 0, /Ines Calloway/);
    await expectWholeReply(page, reply);
    await named(page, channelId);
  });

  const view = fullSize(page);
  const address = view.getByRole("textbox", { name: "Address" });
  const tabs = view.getByRole("tablist", { name: "Tabs" });

  await test.step("the full-size screen shows where the Bot is, and nothing in it acts", async () => {
    const panel = await openComputer(page);
    await panel
      .getByRole("button", { name: "Open the Bot's screen full size" })
      .click();
    await expect(view).toBeVisible();
    await expect(address).toHaveValue(`${SITE}/about`);
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      "About Fernhill Garden Supply",
    );
    for (const name of ["Back", "Forward", "Reload"]) {
      await expect(
        view.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    }
    await expect(view.getByText("Take control to record.")).toBeVisible();
    await shot("full-size-bot-has-control");
  });

  await test.step("take control", async () => {
    await view.getByRole("button", { name: "Take control" }).click();
    await expect(
      view.getByText("You have control. Click and type on the page."),
    ).toBeVisible();
    await expect(view.getByRole("button", { name: "Hand back" })).toBeEnabled();
    await expect(view.getByRole("application", { name: /./ })).toBeVisible();
    for (const name of ["Back", "Forward", "Reload"]) {
      await expect(
        view.getByRole("button", { name, exact: true }),
      ).toBeEnabled();
    }
    await shot("you-have-control");
  });

  await test.step("go somewhere from the address bar, back, forward and reload", async () => {
    await address.fill(`${SITE}/`);
    await address.press("Enter");
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      "Fernhill Garden Supply",
    );
    await expect(address).toHaveValue(`${SITE}/`);
    await shot("went-home");

    await view.getByRole("button", { name: "Back", exact: true }).click();
    await expect(address).toHaveValue(`${SITE}/about`);
    await view.getByRole("button", { name: "Forward", exact: true }).click();
    await expect(address).toHaveValue(`${SITE}/`);
    await view.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(address).toHaveValue(`${SITE}/`);
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      "Fernhill Garden Supply",
    );
  });

  await test.step("open a new tab, browse in it, and close it", async () => {
    await view.getByRole("button", { name: "New tab" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    // A new tab takes the keyboard into its address, as a desktop browser's does.
    await expect(address).toBeFocused();
    await address.fill(`${SITE}/volunteer`);
    await address.press("Enter");
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      "Volunteer at Fernhill",
    );
    await shot("two-tabs");

    // Delete on a tab closes it (the tab says so in `aria-keyshortcuts`), as its × does.
    await tabs.getByRole("tab", { selected: true }).press("Delete");
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
      "Fernhill Garden Supply",
    );
    await expect(address).toHaveValue(`${SITE}/`);
    // The tab left in front fills the screen, with no black band under the page.
    await expectScreenFillsFrame(view.locator("canvas"));
    await shot("tab-closed");
  });

  await test.step("Clear browser data asks first, and Cancel keeps it", async () => {
    await view.getByRole("button", { name: "Clear browser data" }).click();
    const confirm = page.getByRole("dialog", { name: "Clear this browser?" });
    await expect(confirm).toBeVisible();
    await shot("clear-browser-asks");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(address).toHaveValue(`${SITE}/`);
  });

  await test.step("hand back", async () => {
    await view.getByRole("button", { name: "Hand back" }).click();
    await expect(
      view.getByRole("button", { name: "Take control" }),
    ).toBeVisible();
    for (const name of ["Back", "Forward", "Reload"]) {
      await expect(
        view.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    }
    await expectScreenFillsFrame(view.locator("canvas"));
    await shot("handed-back");
    await view.getByRole("button", { name: "Close the Bot's screen" }).click();
    await expect(view).toBeHidden();
    await expect(
      computerPanel(page).getByText("Fernhill Guide has control"),
    ).toBeVisible();
    // What the person did is theirs, not the Bot's: Activity still lists only the Bot's one page.
    await expect(
      activityRows(page).filter({ hasText: "Opened page" }),
    ).toHaveCount(1);
  });

  await test.step("Settings → Computer lists the Bot's browser, to stop or reset", async () => {
    await page.goto("/settings/computer");
    await expect(
      page.getByRole("heading", { name: "Your Bots' browsers" }),
    ).toBeVisible();
    const row = settingsRow(page, "Fernhill Guide");
    await expect(row).toContainText("Browser running since");
    await shot("settings-browsers");

    await row.getByRole("button", { name: "Stop browser" }).click();
    await expect(row).toContainText("No browser running");

    await row.getByRole("button", { name: "Reset" }).click();
    const confirm = page.getByRole("dialog", {
      name: "Reset Fernhill Guide's browser?",
    });
    await expect(confirm).toContainText("You can't undo this.");
    await shot("reset-asks");
    // Every title the dialog shows from here until it has gone, as it fades out.
    await confirm.evaluate((dialog) => {
      const titles = new Set<string>();
      const heading = () =>
        dialog.querySelector('[data-slot="dialog-title"]')?.textContent ?? "";
      titles.add(heading());
      new MutationObserver(() => titles.add(heading())).observe(dialog, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      (window as unknown as { resetTitles: Set<string> }).resetTitles = titles;
    });
    await confirm.getByRole("button", { name: "Reset it" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // It says whose browser it resets until it has gone: it never falls back to another title as it closes.
    expect(
      await page.evaluate(() => [
        ...(window as unknown as { resetTitles: Set<string> }).resetTitles,
      ]),
    ).toEqual(["Reset Fernhill Guide's browser?"]);
    // Reset deletes the Bot's browser: it leaves the list until the Bot next opens a page.
    await expect(row).toHaveCount(0);
    await shot("reset-done");
  });
});
