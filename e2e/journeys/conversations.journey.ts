import { expect, test } from "../harness/test";
import {
  answerOf,
  conversationRow,
  escapeRegExp,
  expectSettled,
  expectStill,
  generatedName,
  send,
  transcript,
  watchForStop,
} from "./chat";

/**
 * CONVERSATIONS, as a person keeps them: started from the + button with the Bot chosen in the To:
 * field, and from the home page; the list in the sidebar, newest first; search; rename (and back to
 * OpenBot's name); pin and unpin from the list and from the conversation's own panel; the command
 * menu; a new conversation from the panel; and delete, from the list and from the panel, each with
 * its confirmation.
 */

const ASSISTANT = "Personal Assistant";
const LIGHTHOUSE =
  "In one short plain sentence, how tall is a typical lighthouse on a rocky coast?";
const KITTEN =
  "In one short plain sentence, what is a good name for a ginger kitten?";
const KINGFISHER =
  "In one short plain sentence, what colour is a kingfisher's back?";
const RENAMED = "Lighthouse heights";
const BIRD_BOT = "Bird Song Guide";

test("a person starts, finds, renames, pins and deletes conversations", async ({
  page,
  shot,
}) => {
  const search = page.getByRole("textbox", { name: "Search conversations" });
  let lighthouse = { id: "", name: "" };
  let kitten = { id: "", name: "" };
  let kingfisher = { id: "", name: "" };

  await test.step("the + button: choose a Bot in To:, or be asked to", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(/\/channel\/new$/);
    const to = page.getByRole("combobox", { name: "Choose a Bot…" });
    // The Bot picker opens on its own, with every Bot and a way to make a new one.
    await expect(to).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("option", { name: new RegExp(`^${ASSISTANT} `) }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Bot Create a new Bot" }),
    ).toBeVisible();
    await shot("new-conversation-picker");

    // Written before a Bot is chosen, the message waits and the picker asks for one.
    await page.keyboard.press("Escape");
    await expect(to).toHaveAttribute("aria-expanded", "false");
    await send(page, LIGHTHOUSE);
    await expect(page.getByText("Choose a Bot first.")).toBeVisible();
    await expect(to).toHaveAttribute("aria-expanded", "true");
    await shot("choose-a-bot-first");

    await page
      .getByRole("option", { name: new RegExp(`^${ASSISTANT} `) })
      .click();
    await expect(
      page.getByRole("button", { name: `Remove ${ASSISTANT}` }),
    ).toBeVisible();
    await expect(page.getByText("Choose a Bot first.")).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveText(
      LIGHTHOUSE,
    );
    await page.getByRole("button", { name: "Send message" }).click();
    const { channelId } = await answerOf(page);
    await expect(
      transcript(page).getByText(LIGHTHOUSE, { exact: true }),
    ).toBeVisible();
    lighthouse = { id: channelId, name: await generatedName(page, channelId) };
    await shot("lighthouse-answer");
  });

  await test.step("the home page, with the Bot chosen by @", async () => {
    // With one Bot OpenBot sends there; with several it asks a model which. That choice reads the
    // whole roster, which the journeys before this one change, so this one names its Bot with @.
    await page.getByRole("link", { name: "OpenBot" }).click();
    await expect(
      page.getByRole("heading", { name: "Start a conversation", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("OpenBot picks the right Bot.")).toBeVisible();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.click();
    await page.keyboard.type("@Pers");
    const mentions = page.getByRole("listbox", { name: "@ suggestions" });
    await expect(
      mentions.getByRole("option", { name: new RegExp(`^${ASSISTANT}`) }),
    ).toBeVisible();
    await shot("mention-picker");
    await mentions
      .getByRole("option", { name: new RegExp(`^${ASSISTANT}`) })
      .click();
    await expect(
      message.getByRole("button", { name: `@${ASSISTANT}` }),
    ).toBeVisible();
    await page.keyboard.type(KITTEN);
    await page.getByRole("button", { name: "Send message" }).click();
    const { channelId } = await answerOf(page);
    await expect(
      page
        .locator('[data-slot="conversation-header"]')
        .getByText(ASSISTANT, { exact: true }),
    ).toBeVisible();
    kitten = { id: channelId, name: await generatedName(page, channelId) };
  });

  await test.step("the list: newest first, each with its Bot and name", async () => {
    const rows = page.locator('a[href^="/channel/channel_"]');
    const kittenRow = conversationRow(page, kitten.name);
    const lighthouseRow = conversationRow(page, lighthouse.name);
    await expect(kittenRow).toContainText(ASSISTANT);
    await expect(lighthouseRow).toContainText(ASSISTANT);
    const order = await rows.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    );
    expect(order.indexOf(`/channel/${kitten.id}`)).toBeLessThan(
      order.indexOf(`/channel/${lighthouse.id}`),
    );
    await shot("conversation-list");
  });

  await test.step("search: a hint under two characters, matches, nothing, and back", async () => {
    await search.fill("l");
    await expect(
      page.getByText("Type at least 2 characters to search history"),
    ).toBeVisible();
    await search.fill("lighthouse");
    await expect(
      page.getByText("Search conversation names and recent messages"),
    ).toBeVisible();
    await expect(conversationRow(page, lighthouse.name)).toBeVisible();
    await expect(conversationRow(page, kitten.name)).toHaveCount(0);
    await shot("search-match");

    await search.fill("quartzfinch");
    await expect(
      page.getByText("No conversations match your search"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No conversation has “quartzfinch” in its name or recent messages.",
      ),
    ).toBeVisible();
    await shot("search-no-match");

    await search.fill("");
    await expect(conversationRow(page, lighthouse.name)).toBeVisible();
    await expect(conversationRow(page, kitten.name)).toBeVisible();
  });

  await test.step("rename: it sticks after a reload, and empty goes back to OpenBot's name", async () => {
    await conversationRow(page, lighthouse.name).click({ button: "right" });
    for (const item of [
      "Pin conversation",
      "Rename conversation…",
      "Delete conversation…",
    ]) {
      await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    }
    await expectSettled(page.getByRole("menu"));
    await shot("conversation-menu");
    await page.getByRole("menuitem", { name: "Rename conversation…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename conversation" });
    const field = dialog.getByRole("textbox", { name: "Name" });
    await expect(field).toHaveValue(lighthouse.name);
    await expect(dialog).toContainText(
      "Leave it empty to go back to the name OpenBot chose.",
    );
    await field.fill(RENAMED);
    await expectSettled(dialog);
    await shot("rename-dialog");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(conversationRow(page, RENAMED)).toHaveAttribute(
      "href",
      `/channel/${lighthouse.id}`,
    );

    await page.reload();
    await expect(conversationRow(page, RENAMED)).toHaveAttribute(
      "href",
      `/channel/${lighthouse.id}`,
    );
    await shot("renamed-after-reload");

    // Cancel changes nothing.
    await conversationRow(page, RENAMED).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename conversation…" }).click();
    await field.fill("Not this name");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(conversationRow(page, RENAMED)).toBeVisible();

    // Empty, saved with Enter: OpenBot's own name again.
    await conversationRow(page, RENAMED).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename conversation…" }).click();
    await field.fill("");
    await field.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(conversationRow(page, RENAMED)).toHaveCount(0);
    await expect(conversationRow(page, lighthouse.name)).toHaveAttribute(
      "href",
      `/channel/${lighthouse.id}`,
    );
  });

  await test.step("pin: pinned first, from the list and from the conversation's panel", async () => {
    const firstRow = page.locator('a[href^="/channel/channel_"]').first();
    await expect(firstRow).toHaveAttribute("href", `/channel/${kitten.id}`);

    // From the list: the older conversation, pinned, goes to the top.
    await conversationRow(page, lighthouse.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin conversation" }).click();
    await expect(firstRow).toHaveAttribute("href", `/channel/${lighthouse.id}`);
    await expect(page.getByRole("menu")).toBeHidden();
    await expectStill(conversationRow(page, kitten.name));
    await shot("pinned");
    await page.reload();
    await expect(firstRow).toHaveAttribute("href", `/channel/${lighthouse.id}`);
    await conversationRow(page, lighthouse.name).click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Unpin conversation" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // From its panel. Opened, a conversation whose Bot has finished never offers to stop it, not
    // even while its history loads.
    await expect(
      page.getByRole("button", { name: "Stop the Bot" }),
    ).toHaveCount(0);
    const stopShown = await watchForStop(page);
    await conversationRow(page, lighthouse.name).click();
    await expect(page).toHaveURL(new RegExp(`/channel/${lighthouse.id}$`));
    await expect(
      transcript(page).getByText(LIGHTHOUSE, { exact: true }),
    ).toBeVisible();
    expect(await stopShown(), "Stop the Bot shown with nothing running").toBe(
      false,
    );
    const settings = page.getByRole("button", {
      name: "This conversation's Bot",
    });
    await settings.click();
    await expect(settings).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/\?settings=true$/);
    const panel = page
      .getByRole("heading", { name: "This conversation", level: 2 })
      .locator("..");
    // The Bot's card: who it is, what it does, and what can be done from here.
    const profile = page
      .getByRole("heading", { name: ASSISTANT, level: 1 })
      .last();
    await expectSettled(profile);
    await expect(
      page.getByRole("heading", { name: "What it does", level: 2 }),
    ).toBeVisible();
    const open = `Open ${ASSISTANT}`;
    await expect(
      page
        .getByRole("link", { name: open })
        .or(page.getByRole("button", { name: open })),
    ).toHaveAttribute("href", "/bots/personal-assistant");
    await expectSettled(
      panel.getByRole("button", { name: "Unpin conversation" }),
    );
    await shot("conversation-panel");
    await panel.getByRole("button", { name: "Unpin conversation" }).click();
    await expect(firstRow).toHaveAttribute("href", `/channel/${kitten.id}`);
    await panel.getByRole("button", { name: "Pin conversation" }).click();
    await expect(firstRow).toHaveAttribute("href", `/channel/${lighthouse.id}`);
    await panel.getByRole("button", { name: "Unpin conversation" }).click();
    await expect(firstRow).toHaveAttribute("href", `/channel/${kitten.id}`);
    await settings.click();
    await expect(settings).toHaveAttribute("aria-pressed", "false");
  });

  await test.step("the command menu opens a conversation and a Bot", async () => {
    await page.goto("/bots");
    await expect(
      page.getByRole("heading", { name: "Bots", level: 1 }),
    ).toBeVisible();
    await page.keyboard.press("ControlOrMeta+K");
    const menu = page.getByRole("dialog", { name: "Command palette" });
    const box = menu.getByRole("combobox", {
      name: "Search pages, Bots and conversations",
    });
    await expect(box).toBeFocused();
    await expect(menu.getByRole("group", { name: "Pages" })).toBeVisible();
    await expect(
      menu.getByRole("group", { name: "Conversations" }),
    ).toBeVisible();
    await expectSettled(menu);
    await shot("command-menu");

    await box.fill("lighthouse");
    const found = menu
      .getByRole("group", { name: "Conversations" })
      .getByRole("option", { name: new RegExp(escapeRegExp(lighthouse.name)) });
    await expect(found).toBeVisible();
    await shot("command-menu-search");
    await found.click();
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/channel/${lighthouse.id}$`));
    await expect(
      transcript(page).getByText(LIGHTHOUSE, { exact: true }),
    ).toBeVisible();

    await page.keyboard.press("ControlOrMeta+K");
    await box.fill(ASSISTANT);
    await menu
      .getByRole("group", { name: "Bots" })
      .getByRole("option", { name: new RegExp(`^${ASSISTANT}`) })
      .click();
    await expect(page).toHaveURL(/\/bots\/personal-assistant$/);
    await expect(
      page.getByRole("heading", { name: ASSISTANT, level: 1 }),
    ).toBeVisible();

    // Escape closes it without going anywhere.
    await page.keyboard.press("ControlOrMeta+K");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/\/bots\/personal-assistant$/);
  });

  await test.step("a new conversation from the panel, then deleted from it", async () => {
    await page.goto(`/channel/${lighthouse.id}?settings=true`);
    // The panel's own button, with words; the sidebar's is the bare + of the same name.
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .filter({ hasText: "New conversation" })
      .click();
    await expect(page).toHaveURL(/\/channel\/new\?agent=personal-assistant$/);
    await expect(
      page.getByRole("button", { name: `Remove ${ASSISTANT}` }),
    ).toBeVisible();
    // Shift+Enter is a new line; Enter sends.
    const message = page.getByRole("textbox", { name: "Message" });
    await message.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(message).toHaveText(/first line\s*second line/);
    expect(
      await message.evaluate(
        (box) => (box as HTMLElement).innerText.split("\n").length,
      ),
    ).toBeGreaterThan(1);
    await message.fill(KINGFISHER);
    await message.press("Enter");
    const { channelId } = await answerOf(page);
    kingfisher = { id: channelId, name: await generatedName(page, channelId) };
    await expect(conversationRow(page, kingfisher.name)).toBeVisible();

    await page.getByRole("button", { name: "This conversation's Bot" }).click();
    await page.getByRole("button", { name: "Delete conversation…" }).click();
    // Named by the conversation's own name, not its Bot's.
    const dialog = page.getByRole("dialog", {
      name: `Delete “${kingfisher.name}”?`,
    });
    await expect(dialog).toContainText(
      "It disappears for everyone in the conversation.",
    );
    await expect(
      page.getByRole("dialog", { name: `Delete ${ASSISTANT}?` }),
    ).toHaveCount(0);
    await expectSettled(dialog);
    await shot("delete-from-panel");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    // Deleting the open conversation goes home.
    await expect(page).toHaveURL(/\/$/);
    await expect(conversationRow(page, kingfisher.name)).toHaveCount(0);
  });

  await test.step("delete from the list: Cancel keeps it, Delete removes it", async () => {
    await conversationRow(page, kitten.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete conversation…" }).click();
    const dialog = page.getByRole("dialog", {
      name: `Delete “${kitten.name}”?`,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(conversationRow(page, kitten.name)).toBeVisible();

    await conversationRow(page, kitten.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete conversation…" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(conversationRow(page, kitten.name)).toHaveCount(0);
    await expect(conversationRow(page, lighthouse.name)).toBeVisible();
    // Gone for good, not just from this tab.
    await page.reload();
    await expect(conversationRow(page, lighthouse.name)).toBeVisible();
    await expect(conversationRow(page, kitten.name)).toHaveCount(0);
    await shot("after-deletes");
  });

  await test.step("a Bot made from the To: field joins the conversation", async () => {
    await page
      .getByRole("button", { name: "New conversation" })
      .first()
      .click();
    await page
      .getByRole("button", { name: "New Bot Create a new Bot" })
      .click();
    const sheet = page.getByRole("dialog", { name: "New Bot" });
    await sheet.getByRole("textbox", { name: "Name" }).fill(BIRD_BOT);
    await sheet.getByRole("button", { name: "Create Bot" }).click();
    await expect(sheet).toBeHidden();
    // Made, and addressed: the new Bot is in To:, not opened on its own page.
    await expect(page).toHaveURL(/\/channel\/new\?agent=agent_/);
    const chip = page.getByRole("button", { name: `Remove ${BIRD_BOT}` });
    await expect(chip).toBeVisible();
    await shot("new-bot-in-to");
    await chip.click();
    await expect(chip).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Choose a Bot…" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("the sidebar folds away and comes back", async () => {
    await page.getByRole("link", { name: "OpenBot" }).click();
    await expect(search).toBeVisible();
    // Folded, the sidebar slides off the page; the page takes its room.
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
    await expect(search).not.toBeInViewport();
    await expectStill(
      page.getByRole("heading", { name: "Start a conversation", level: 1 }),
    );
    await shot("sidebar-folded");
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
    await expect(search).toBeInViewport();
    await expect(conversationRow(page, lighthouse.name)).toBeVisible();
  });
});
