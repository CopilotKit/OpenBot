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
});
