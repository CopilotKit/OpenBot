import { expect, test } from "../harness/test";
import {
  answerOf,
  conversationRow,
  createBot,
  expectSettled,
  expectStill,
  generatedName,
  send,
  transcript,
} from "./chat";

/**
 * EVERYTHING THE PROFILE'S "FOR YOU" AND "MANAGE" SECTIONS DO, on a Bot this journey makes: pause
 * and resume it, choose its notifications, pin it, hide it and bring it back, duplicate it, reset
 * it, and delete it, after which its conversations stay readable but it can't reply.
 */

const BOT = "Recipe Scaler";
const COPY = "Recipe Scaler Copy";
const INSTRUCTIONS =
  "You scale cooking recipes up and down. Answer in one short plain sentence.";
const QUESTION =
  "How much flour do I need if I triple a recipe that uses 150 grams?";
const COPY_QUESTION =
  "How many eggs do I need if I halve a recipe that uses 4 eggs?";

test("a person pauses, pins, hides, duplicates, resets and deletes a Bot", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const roster = (name: string) =>
    main.getByRole("link", { name: new RegExp(`^${name} ${name}`) });
  let agentId = "";
  let copyId = "";

  await test.step("a Bot, and a conversation with it", async () => {
    agentId = await createBot(page, BOT, INSTRUCTIONS);
    await page.goto(`/channel/new?agent=${agentId}`);
    await send(page, QUESTION);
    const { channelId } = await answerOf(page);
    await expect(transcript(page)).toContainText("450");
    await generatedName(page, channelId);
    await page.goto(`/bots/${agentId}`);
  });

  await test.step("pause it, and turn it back on", async () => {
    const active = main.getByRole("switch", { name: "Active" });
    await active.click();
    await expect(active).not.toBeChecked();
    await expect(
      main.getByText("Paused. Nothing runs for you until you turn it back on."),
    ).toBeVisible();
    const banner = main.getByRole("button", { name: "Paused. Resume" });
    await expect(banner).toBeVisible();
    await expectStill(active.locator('[data-slot="switch-thumb"]'));
    await shot("paused");

    // The Bots list says so.
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(roster(BOT)).toContainText("Paused");
    await shot("bots-list-paused");
    await roster(BOT).click();

    // Resumed from the banner.
    await banner.click();
    await expect(banner).toBeHidden();
    await expect(active).toBeChecked();
    await expect(
      main.getByText(
        "Works on its goals, routines, hand-offs and follow-ups for you.",
      ),
    ).toBeVisible();
  });

  await test.step("choose what it notifies about", async () => {
    const notifications = main.getByRole("combobox", { name: "Notifications" });
    await notifications.click();
    for (const option of [
      "Everything",
      "Only when it needs me",
      "Nothing (badges only)",
    ]) {
      await expect(page.getByRole("option", { name: option })).toBeVisible();
    }
    await shot("notifications-options");
    await page.getByRole("option", { name: "Only when it needs me" }).click();
    await expect(notifications).toContainText("Only when it needs me");
    await expect(
      main.getByText("Only when it needs me. Sidebar badges always show."),
    ).toBeVisible();
    await expect(page.getByRole("listbox")).toBeHidden();
    await shot("notifications-only-when-needed");
    await page.reload();
    await expect(notifications).toContainText("Only when it needs me");
    await notifications.click();
    await page.getByRole("option", { name: "Everything" }).click();
    await expect(notifications).toContainText("Everything");
  });

  await test.step("pin it to the top of the Bots list, and unpin it", async () => {
    const pinned = main.getByRole("switch", { name: "Pinned" });
    await pinned.click();
    await expect(pinned).toBeChecked();
    await expect(main.getByText("At the top of your Bots list.")).toBeVisible();
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    const pinnedSection = main.getByRole("heading", {
      name: "Pinned",
      level: 2,
    });
    await expect(pinnedSection).toBeVisible();
    // Pinned comes first, with the Bot in it.
    await expect(main.getByRole("heading", { level: 2 }).first()).toHaveText(
      "Pinned",
    );
    await expect(roster(BOT)).toBeVisible();
    await shot("bots-list-pinned");
    await roster(BOT).click();
    await pinned.click();
    await expect(pinned).not.toBeChecked();
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(pinnedSection).toBeHidden();
    await expect(roster(BOT)).toBeVisible();
  });

  await test.step("hide it, find it under Hidden, and bring it back", async () => {
    await roster(BOT).click();
    await main.getByRole("switch", { name: "Hidden" }).click();
    // Hiding takes you back to the list, where it is not.
    await expect(page).toHaveURL(/\/bots$/);
    await expect(roster(BOT)).toHaveCount(0);
    await expect(
      main.getByRole("heading", { name: "Hidden", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText(/\d+ Bots? you hid\./)).toBeVisible();
    await shot("bots-list-hidden");

    await main.getByRole("button", { name: "Show" }).click();
    await expect(roster(BOT)).toBeVisible();
    await shot("bots-list-hidden-shown");
    await main.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(roster(BOT)).toHaveCount(0);
    await main.getByRole("button", { name: "Show" }).click();
    await roster(BOT).click();
    const hidden = main.getByRole("switch", { name: "Hidden" });
    await expect(hidden).toBeChecked();
    await expect(
      main.getByText("Under Hidden on your Bots list."),
    ).toBeVisible();
    await hidden.click();
    await expect(hidden).not.toBeChecked();
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(roster(BOT)).toBeVisible();
  });

  await test.step("duplicate it", async () => {
    await roster(BOT).click();
    await main.getByRole("button", { name: /^Duplicate / }).click();
    // The copy opens, under the same name and with the same instructions.
    await expect(page).not.toHaveURL(new RegExp(`/bots/${agentId}$`));
    await expect(page).toHaveURL(/\/bots\/agent_[0-9a-f-]+$/);
    copyId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(
      main.getByRole("heading", { name: BOT, level: 1 }),
    ).toBeVisible();
    await expect(main.getByText(INSTRUCTIONS)).toBeVisible();
    await shot("duplicate");

    // Named apart, so the two can be told apart.
    await main.getByRole("link", { name: /^Setup / }).click();
    await main.getByRole("button", { name: `Name ${BOT}` }).click();
    const dialog = page.getByRole("dialog", { name: "Name" });
    await dialog.getByRole("textbox", { name: "Name" }).fill(COPY);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(
      main.getByRole("button", { name: `Name ${COPY}` }),
    ).toBeVisible();
    await main.getByRole("button", { name: COPY, exact: true }).click();
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(roster(BOT)).toBeVisible();
    await expect(roster(COPY)).toBeVisible();
    await shot("bots-list-with-copy");
  });

  await test.step("reset: nothing to delete on the fresh copy, a conversation on the original", async () => {
    await roster(COPY).click();
    await main.getByRole("button", { name: /^Reset / }).click();
    let dialog = page.getByRole("dialog", { name: `Reset ${COPY}?` });
    await expect(dialog).toContainText("There's nothing of yours to delete.");
    await expect(
      dialog.getByRole("button", { name: "Delete and reset" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.goto(`/bots/${agentId}`);
    const conversation = conversationRow(page, BOT);
    await expect(conversation).toBeVisible();
    await main.getByRole("button", { name: /^Reset / }).click();
    dialog = page.getByRole("dialog", { name: `Reset ${BOT}?` });
    await expect(dialog).toContainText("This will delete:");
    await expect(dialog.getByRole("listitem").first()).toHaveText(
      "1 conversation",
    );
    await expectSettled(dialog);
    await shot("reset-dialog");
    await dialog.getByRole("button", { name: "Delete and reset" }).click();
    await expect(dialog).toContainText(`Done. ${BOT} starts fresh with you.`);
    await shot("reset-done");
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toBeHidden();
    // Its conversation is gone; the Bot is not.
    await expect(conversation).toHaveCount(0);
    await expect(
      main.getByRole("heading", { name: BOT, level: 1 }),
    ).toBeVisible();
  });

  await test.step("delete: Cancel keeps it, Delete removes it, its conversation stays readable", async () => {
    await page.goto(`/channel/new?agent=${copyId}`);
    await send(page, COPY_QUESTION);
    const { channelId } = await answerOf(page);
    await generatedName(page, channelId);

    await page.goto(`/bots/${copyId}`);
    await main.getByRole("button", { name: /^Delete / }).click();
    const dialog = page.getByRole("dialog", { name: `Delete ${COPY}?` });
    await expect(dialog).toContainText(
      "You can still read your conversations with it, but it can't reply. You can't undo this.",
    );
    await expectSettled(dialog);
    await shot("delete-dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("heading", { name: COPY, level: 1 }),
    ).toBeVisible();

    await main.getByRole("button", { name: /^Delete / }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL(/\/bots$/);
    await expect(roster(COPY)).toHaveCount(0);
    await expect(roster(BOT)).toBeVisible();
    await shot("bots-list-after-delete");

    // Its conversation is still there to read, and says why it can't go on.
    await page.goto(`/channel/${channelId}`);
    await expect(
      transcript(page).getByText(COPY_QUESTION, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This Bot was deleted. You can still read this conversation, but the Bot can't reply.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
    await shot("conversation-with-deleted-bot");
  });
});
