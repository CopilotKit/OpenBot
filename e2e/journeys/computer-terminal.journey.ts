import {
  activityRows,
  CLOCK,
  computerPanel,
  expect,
  expectWholeReply,
  named,
  newConversation,
  openComputer,
  replyAfter,
  send,
  test,
  turnOver,
} from "./computer-steps";

/**
 * THE BOT'S COMPUTER, ITS TERMINAL. A Bot runs a command; Activity shows it with what it printed,
 * and the Terminal tab shows the Bot's live shell. The person takes control of the terminal, types a
 * command of their own, and hands it back.
 */

test("a Bot runs a command in its terminal, and the person types in it too", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(300_000);
  const botId = await makeBot(
    "Fernhill Tinkerer",
    "Run small shell commands for me and report what they print.",
  );
  let channelId = "";

  await test.step("the Bot runs a command", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      "In your terminal, run the command echo fernhill-$((40+2)) and tell me what it printed, in one plain sentence with no formatting.",
    );
    await turnOver(page);
    const reply = await replyAfter(page, channelId, 0, /fernhill-42/);
    await expectWholeReply(page, reply);
    await named(page, channelId);
  });

  const terminal = computerPanel(page).getByRole("region", {
    name: /^The Bot's terminal/,
  });

  await test.step("the Computer shows the command in Activity and the terminal", async () => {
    const panel = await openComputer(page);
    await panel.getByRole("tab", { name: "Terminal" }).click();
    await expect(panel.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(terminal).toBeVisible();
    await expect(panel.getByText("The Bot has control.")).toBeVisible();
    const ran = activityRows(page).filter({ hasText: "echo fernhill-" });
    await expect(ran).toHaveCount(1);
    await expect(ran).toContainText("fernhill-42");
    await expect(ran.locator("time")).toHaveText(CLOCK);
    await shot("terminal-and-activity");
  });

  await test.step("take control of the terminal, type, and hand it back", async () => {
    const panel = computerPanel(page);
    await panel.getByRole("button", { name: "Take control" }).click();
    await expect(
      panel.getByText("of the terminal and the screen."),
    ).toBeVisible();
    await expect(
      panel.getByRole("status").filter({ hasText: "You have control" }),
    ).toBeVisible();
    const typing = panel.getByRole("region", {
      name: "The Bot's terminal. You have control. Type here.",
    });
    await expect(typing).toBeVisible();
    await typing.click();
    await page.keyboard.type("echo typed-by-$((6*7))");
    await page.keyboard.press("Enter");
    await expect(typing).toContainText("typed-by-42");
    await shot("person-typed");

    await panel.getByRole("button", { name: "Hand back" }).click();
    await expect(panel.getByText("The Bot has control.")).toBeVisible();
    await expect(terminal).toHaveAccessibleName("The Bot's terminal");
    await shot("terminal-handed-back");
  });
});
