import { expect, test } from "../harness/test";
import {
  answerOf,
  createBot,
  expectSettled,
  generatedName,
  send,
  transcript,
} from "./chat";

/**
 * EDITING A BOT on its Setup page: its name, its title and what it does, which for a Bot a person
 * made is also what it runs on. Each edit is refused when it should be, can be cancelled, survives
 * a reload, shows wherever the Bot is named, and the changed instructions are what it answers by.
 */

const FIRST_NAME = "Tide Table Helper";
const NAME = "Harbour Tide Helper";
const TITLE = "Coastal walks";
const FIRST_INSTRUCTIONS =
  "You explain tides for coastal walkers. Reply in one plain sentence that starts with the words: Tide note:";
const INSTRUCTIONS =
  "You explain tides for coastal walkers. Reply in one plain sentence that starts with the words: Harbour note:";
const QUESTION =
  "Is a falling tide or a rising tide safer for a beach walk around a headland?";

test("a person edits a Bot's name, title and instructions", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  let agentId = "";

  await test.step("a Bot to edit", async () => {
    agentId = await createBot(page, FIRST_NAME, FIRST_INSTRUCTIONS);
    await main.getByRole("link", { name: /^Setup / }).click();
    await expect(
      main.getByRole("heading", { name: "Setup", level: 1 }),
    ).toBeVisible();
    await shot("setup-before");
  });

  await test.step("the name: required, cancellable, saved with Enter", async () => {
    await main.getByRole("button", { name: `Name ${FIRST_NAME}` }).click();
    const dialog = page.getByRole("dialog", { name: "Name" });
    const field = dialog.getByRole("textbox", { name: "Name" });
    await expect(field).toHaveValue(FIRST_NAME);
    await expect(field).toBeFocused();

    await field.fill("");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Name is required.");
    await expectSettled(dialog);
    await shot("name-required");

    // Cancel keeps the old name.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: `Name ${FIRST_NAME}` }),
    ).toBeVisible();

    await main.getByRole("button", { name: `Name ${FIRST_NAME}` }).click();
    await field.fill(NAME);
    await field.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: `Name ${NAME}` }),
    ).toBeVisible();
    // The way back is named after it too.
    await expect(
      main.getByRole("button", { name: NAME, exact: true }),
    ).toBeVisible();
  });

  await test.step("the title", async () => {
    await main
      .getByRole("button", { name: "Title Powered by OpenBot" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Title" });
    await dialog.getByRole("textbox", { name: "Title" }).fill(TITLE);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: `Title ${TITLE}` }),
    ).toBeVisible();
  });

  await test.step("what it does: too long is refused, then new instructions saved", async () => {
    await main
      .getByRole("button", { name: `What it does ${FIRST_INSTRUCTIONS}` })
      .click();
    const dialog = page.getByRole("dialog", { name: "What it does" });
    const field = dialog.getByRole("textbox", { name: "What it does" });
    await expect(field).toHaveValue(FIRST_INSTRUCTIONS);

    await field.fill("Tides. ".repeat(150));
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "What it does must be 1000 characters or fewer.",
    );
    await field.fill("   ");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "A description of what it does is required.",
    );

    await field.fill(INSTRUCTIONS);
    await expectSettled(dialog);
    await shot("instructions-edit");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      main.getByRole("button", { name: `What it does ${INSTRUCTIONS}` }),
    ).toBeVisible();
    await shot("setup-after");
  });

  await test.step("every edit survives a reload, and shows on the profile and the list", async () => {
    await page.reload();
    await expect(
      main.getByRole("button", { name: `Name ${NAME}` }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: `Title ${TITLE}` }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: `What it does ${INSTRUCTIONS}` }),
    ).toBeVisible();

    await main.getByRole("button", { name: NAME, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/bots/${agentId}$`));
    await expect(
      main.getByRole("heading", { name: NAME, level: 1 }),
    ).toBeVisible();
    await expect(main.getByText(TITLE, { exact: true })).toBeVisible();
    await expect(main.getByText(INSTRUCTIONS)).toBeVisible();
    // Every row has its summary, so the shot is of the page, not of it loading.
    await expect(
      main.getByRole("link", { name: /^Skills \d+ skills?/ }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: /^Apps \d+ apps?/ }),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: /^Activity / })).toBeVisible();
    await shot("profile-after");

    await main.getByRole("button", { name: "Bots", exact: true }).click();
    const row = main.getByRole("link", {
      name: new RegExp(`^${NAME} ${NAME}`),
    });
    await expect(row).toContainText(TITLE);
    await expect(
      main.getByRole("link", { name: new RegExp(`^${FIRST_NAME}`) }),
    ).toHaveCount(0);
    await shot("bots-list-after");
  });

  await test.step("it answers by its new instructions", async () => {
    await page.goto(`/channel/new?agent=${agentId}`);
    await expect(
      page.getByRole("button", { name: `Remove ${NAME}` }),
    ).toBeVisible();
    await send(page, QUESTION);
    const { answer, channelId } = await answerOf(page);
    expect(answer, "it follows the instructions it has now").toMatch(
      /^Harbour note:/,
    );
    await expect(transcript(page)).toContainText("Harbour note:");
    // The conversation introduces it by its new name and title.
    await expect(
      transcript(page).getByRole("heading", { name: NAME, level: 1 }),
    ).toBeVisible();
    await expect(transcript(page)).toContainText(TITLE);
    await shot("answer");
    await generatedName(page, channelId);
  });
});
