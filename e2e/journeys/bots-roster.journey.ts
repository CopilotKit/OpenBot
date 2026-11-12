import { expect, test } from "../harness/test";

/**
 * THE BOTS LIST AND A BOT'S PROFILE, as a person finds them: the Personal Assistant that comes with
 * OpenBot, what it is for, how it is set up, and every row its profile offers. Nothing here changes
 * the Personal Assistant: the journeys that pause, hide, reset or delete a Bot do it to their own.
 */

const ASSISTANT = "Personal Assistant";

test("a person looks through the Bots list and the Personal Assistant's profile", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");

  await test.step("the Bots list", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Bots", exact: true }).click();
    await expect(page).toHaveURL(/\/bots$/);
    await expect(
      main.getByRole("heading", { name: "Bots", level: 1 }),
    ).toBeVisible();
    await expect(main.getByText("Your Bots for everyday work.")).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Included with OpenBot", level: 2 }),
    ).toBeVisible();
    const assistant = main.getByRole("link", {
      name: new RegExp(`^${ASSISTANT} ${ASSISTANT}`),
    });
    await expect(assistant).toHaveAttribute("href", "/bots/personal-assistant");
    await expect(assistant).toContainText("Powered by OpenBot");
    await expect(
      main.getByRole("heading", { name: "What your Bots learn", level: 2 }),
    ).toBeVisible();
    await shot("bots-list");
  });

  await test.step("What your Bots learn opens Skills", async () => {
    await main.getByRole("link", { name: /^Skills Step-by-step/ }).click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(
      page.getByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      main.getByRole("heading", { name: "Bots", level: 1 }),
    ).toBeVisible();
  });

  await test.step("the Personal Assistant's profile", async () => {
    await main
      .getByRole("link", { name: new RegExp(`^${ASSISTANT} ${ASSISTANT}`) })
      .click();
    await expect(page).toHaveURL(/\/bots\/personal-assistant$/);
    await expect(
      main.getByRole("heading", { name: ASSISTANT, level: 1 }),
    ).toBeVisible();
    await expect(main.getByRole("img", { name: ASSISTANT })).toBeVisible();
    await expect(
      main.getByText(
        "Help with email, your calendar, research, planning and everyday errands.",
      ),
    ).toBeVisible();

    // For you: on, everything, and a way to message it.
    await expect(
      main.getByRole("heading", { name: "For you", level: 2 }),
    ).toBeVisible();
    await expect(main.getByRole("switch", { name: "Active" })).toBeChecked();
    await expect(
      main.getByRole("combobox", { name: "Notifications" }),
    ).toContainText("Everything");
    await expect(
      main.getByRole("link", {
        name: `Message ${ASSISTANT} Start a conversation.`,
      }),
    ).toHaveAttribute("href", "/channel/new?agent=personal-assistant");

    // Manage: every action offered, none taken here.
    await expect(
      main.getByRole("heading", { name: "Manage", level: 2 }),
    ).toBeVisible();
    await expect(
      main.getByRole("switch", { name: "Pinned" }),
    ).not.toBeChecked();
    await expect(
      main.getByRole("switch", { name: "Hidden" }),
    ).not.toBeChecked();
    for (const action of ["Duplicate", "Reset", "Delete"]) {
      await expect(
        main.getByRole("button", { name: new RegExp(`^${action} `) }),
      ).toBeVisible();
    }
    await shot("assistant-profile");
    await main
      .getByRole("heading", { name: "Manage", level: 2 })
      .scrollIntoViewIfNeeded();
    await shot("assistant-profile-settings-and-manage");
  });

  await test.step("every setting row opens its page and comes back", async () => {
    const rows: [string, RegExp][] = [
      ["Activity", /^Activity /],
      ["Routines", /^Routines /],
      ["Skills", /^Skills /],
      ["Apps", /^Apps /],
      ["Computer", /^Computer /],
      ["Approvals", /^Approvals /],
      ["Setup", /^Setup /],
    ];
    for (const [title, row] of rows) {
      await main.getByRole("link", { name: row }).click();
      await expect(
        main.getByRole("heading", { name: title, level: 1 }),
      ).toBeVisible();
      // Back, by the button named after the Bot.
      await main.getByRole("button", { name: ASSISTANT, exact: true }).click();
      await expect(
        main.getByRole("heading", { name: ASSISTANT, level: 1 }),
      ).toBeVisible();
    }
  });

  await test.step("its Setup: who it is and what it is told", async () => {
    await main.getByRole("link", { name: /^Setup / }).click();
    await expect(
      main.getByRole("heading", { name: "Setup", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Identity", level: 2 }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: `Name ${ASSISTANT}` }),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: /^Title / })).toBeVisible();
    await expect(
      main.getByRole("button", { name: /^What it does Help with email/ }),
    ).toBeVisible();
    const instructions = main.getByRole("button", { name: /^Instructions / });
    await expect(instructions).toContainText(
      "You are a personal assistant for one person.",
    );
    await expect(
      main.getByRole("heading", { name: "Connection", level: 2 }),
    ).toBeVisible();
    await expect(main.getByText("Built in", { exact: true })).toBeVisible();
    await shot("assistant-setup");

    // The instructions open for editing; Cancel leaves them as they were.
    await instructions.click();
    const dialog = page.getByRole("dialog", { name: "Instructions" });
    await expect(
      dialog.getByRole("textbox", { name: "Instructions" }),
    ).toHaveValue(/^You are a personal assistant for one person\./);
    await shot("assistant-instructions-dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    // OpenBot for Business, offered where a team edition would show visibility and isolation.
    await main
      .getByRole("button", {
        name: "Give each Bot its own computer with OpenBot for Business.",
      })
      .click();
    const business = page.getByRole("dialog");
    await expect(business).toBeVisible();
    await expect(business).toContainText("OpenBot for Business");
    // Faded in, so the screenshot shows it rather than the page through it.
    await expect(business).toHaveCSS("opacity", "1");
    await shot("openbot-for-business");
    await page.keyboard.press("Escape");
    await expect(business).toBeHidden();

    await main.getByRole("button", { name: ASSISTANT, exact: true }).click();
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(page).toHaveURL(/\/bots$/);
  });
});
