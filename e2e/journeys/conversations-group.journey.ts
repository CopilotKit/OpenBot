import type { Locator } from "@playwright/test";
import { expect, test } from "../harness/test";
import { conversationRow, createBot, expectSettled } from "./chat";

/**
 * A CONVERSATION WITH TWO BOTS: the To: field takes a second Bot, which makes it a group; the group
 * opens on its own page with both Bots in its header and the sidebar, and a message to it is
 * answered.
 */

const ASSISTANT = "Personal Assistant";
const KITE = "Kite Forecaster";
const KITE_INSTRUCTIONS =
  "You forecast kite-flying weather. Answer in one short plain sentence.";
const QUESTION =
  "Is a steady 15 km/h breeze good for flying a kite? Answer in one short plain sentence.";

type GroupMessage = { status: string; agentId: string | null; text: string };

/**
 * The colors a Bot is drawn in, read off its still orb (`BotOrb`): its palette's four stops. Empty
 * for anything that is not the orb, such as the generated face a surface outside the skin's look
 * drew instead.
 */
function colorsOf(avatar: Locator): Promise<string> {
  return avatar.evaluate((element) =>
    ["--c1", "--c2", "--c3", "--c4"]
      .map((name) => (element as HTMLElement).style.getPropertyValue(name))
      .join(" ")
      .trim(),
  );
}

test("a person starts a conversation with two Bots", async ({ page, shot }) => {
  let channelId = "";

  await test.step("two Bots in To: make a group", async () => {
    await createBot(page, KITE, KITE_INSTRUCTIONS);
    await page.goto("/channel/new?agent=personal-assistant");
    await expect(
      page.getByRole("button", { name: `Remove ${ASSISTANT}` }),
    ).toBeVisible();
    const add = page.getByRole("combobox", {
      name: "Add another Bot for a group…",
    });
    await add.click();
    await add.fill("Kite");
    await page.getByRole("option", { name: new RegExp(`^${KITE}`) }).click();
    await expect(
      page.getByRole("button", { name: `Remove ${KITE}` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Remove ${ASSISTANT}` }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await shot("group-recipients");
  });

  await test.step("a message to the group is answered", async () => {
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(QUESTION);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/group\/channel_[0-9a-f-]+$/);
    channelId = new URL(page.url()).pathname.split("/").pop() ?? "";

    // The group's own record says when every Bot asked has answered.
    let messages: GroupMessage[] = [];
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/groups/${channelId}`);
          if (!response.ok()) return false;
          messages =
            ((await response.json()) as { messages?: GroupMessage[] })
              .messages ?? [];
          // Each Bot takes its turn after the one before, so done is both answered, none owed.
          const answered = new Set(
            messages
              .filter((entry) => entry.agentId && entry.status === "completed")
              .map((entry) => entry.agentId),
          );
          return (
            answered.size === 2 &&
            messages.every(
              (entry) =>
                entry.status !== "running" && entry.status !== "queued",
            )
          );
        },
        { message: "the group answers", timeout: 120_000 },
      )
      .toBe(true);
    expect(messages.filter((entry) => entry.status === "failed")).toEqual([]);

    await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
    // Each Bot's answer, under its name.
    for (const reply of messages.filter((entry) => entry.agentId)) {
      await expect(
        page.getByText(reply.text.trim().slice(0, 40)).first(),
      ).toBeVisible();
    }
    for (const bot of [ASSISTANT, KITE]) {
      await expect(page.getByText(bot, { exact: true }).last()).toBeVisible();
    }
    // Both Bots are in the header.
    const header = page.locator('[data-slot="conversation-header"]');
    await expect(header).toContainText(ASSISTANT);
    await expect(header).toContainText(KITE);
    await shot("group-answer");
  });

  await test.step("the group in the sidebar", async () => {
    // Under both Bots' names, by its first message, and no longer working.
    const row = conversationRow(page, /Is a steady 15 km\/h breeze/);
    await expect(row).toHaveAttribute("href", `/group/${channelId}`);
    await expect(row).toContainText(ASSISTANT);
    await expect(row).not.toContainText("Working");
    await expectSettled(row);
    await shot("group-in-sidebar");

    // Reopened from the list, it is the same group.
    await page.goto("/");
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/group/${channelId}$`));
    await expect(page.getByText(QUESTION, { exact: true })).toBeVisible();
  });

  await test.step("each Bot is one color everywhere it is drawn", async () => {
    // The orbs beside the conversation's name are hidden from screen readers, so they are found
    // with the hidden ones included; the name beside them is what is read.
    const avatar = (scope: Locator, bot: string) =>
      scope
        .getByRole("img", { name: bot, exact: true, includeHidden: true })
        .first();
    const row = conversationRow(page, /Is a steady 15 km\/h breeze/);
    const said = (bot: string) =>
      page.locator("[data-speaker]").filter({ hasText: bot });
    const seen: Record<string, Record<string, string>> = {};
    for (const bot of [ASSISTANT, KITE]) {
      seen[bot] = {
        "group message": await colorsOf(avatar(said(bot), bot)),
        sidebar: await colorsOf(avatar(row, bot)),
      };
    }

    await page.goto("/bots");
    const main = page.getByRole("main");
    await expect(
      main.getByRole("heading", { name: "Bots", level: 1 }),
    ).toBeVisible();
    for (const bot of [ASSISTANT, KITE]) {
      seen[bot]["Bots list"] = await colorsOf(avatar(main, bot));
    }

    await page.keyboard.press("ControlOrMeta+K");
    const menu = page.getByRole("dialog", { name: "Command palette" });
    await expectSettled(menu);
    const bots = menu.getByRole("group", { name: "Bots" });
    for (const bot of [ASSISTANT, KITE]) {
      seen[bot]["command menu"] = await colorsOf(
        avatar(bots.getByRole("option", { name: new RegExp(`^${bot}`) }), bot),
      );
    }
    await shot("command-menu-colors");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    for (const bot of [ASSISTANT, KITE]) {
      const colors = seen[bot]["Bots list"];
      expect(colors, `${bot} is drawn as its orb`).not.toBe("");
      expect(seen[bot], bot).toEqual({
        "group message": colors,
        sidebar: colors,
        "Bots list": colors,
        "command menu": colors,
      });
    }
  });
});
