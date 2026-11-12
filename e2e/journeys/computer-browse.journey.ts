import { SITE, SITE_HOST } from "../site/site";
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
  serveSite,
  test,
  transcript,
  turnOver,
} from "./computer-steps";

/**
 * THE BOT'S COMPUTER, BROWSING. A Bot opens a page, reads it and answers from it. The Computer opens
 * beside the conversation on the Bot's screen as it browses, Activity lists the page it opened with
 * the time, the conversation folds the browsing into one line that opens to its steps, and a reload
 * keeps Activity.
 */

serveSite();

test("a Bot opens a page, reads it and answers, live on its computer", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(300_000);
  const botId = await makeBot(
    "Fernhill Scout",
    "Look things up on garden shop websites for me and answer briefly.",
  );
  let channelId = "";

  await test.step("ask the Bot to read a page", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Open ${SITE}/ and tell me what time the greenhouse opens on Saturdays. Answer in one short sentence.`,
    );
    await shot("asked");
  });

  await test.step("the Computer opens on the Bot's screen as it browses", async () => {
    const panel = await openComputer(page);
    await expect(panel.getByRole("tab", { name: "Screen" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      panel.getByRole("img", { name: "What the Bot is looking at" }),
    ).toBeVisible({ timeout: 120_000 });
    // The card reads as a browser window: where it is, as an address bar says it.
    await expect(panel.getByText(SITE_HOST, { exact: true })).toBeVisible();
    await expect(panel.getByText("Fernhill Scout has control")).toBeVisible();
    await shot("computer-live");
  });

  await test.step("the answer comes from the page", async () => {
    await turnOver(page);
    const reply = await replyAfter(page, channelId, 0, /7:40/);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    await shot("answer");
  });

  await test.step("Activity lists the page it opened, with the time", async () => {
    const opened = activityRows(page).filter({ hasText: "Opened page" });
    await expect(opened).toHaveCount(1);
    await expect(opened).toContainText(`${SITE}/`);
    await expect(opened).toContainText("Fernhill Garden Supply");
    await expect(opened.locator("time")).toHaveText(CLOCK);
    await expect(computerPanel(page).getByText(/^Nothing yet/)).toHaveCount(0);
    await shot("activity");
  });

  await test.step("the conversation folds the browsing into one line that opens to its steps", async () => {
    const fold = transcript(page).getByText("Browsed host.docker.internal", {
      exact: true,
    });
    await expect(fold).toBeVisible();
    await fold.click();
    await expect(
      transcript(page).getByRole("link", { name: "Fernhill Garden Supply" }),
    ).toHaveAttribute("href", `${SITE}/`);
    await shot("browsing-unfolded");
  });

  await test.step("after a reload, Activity still lists what was done", async () => {
    await page.reload();
    const panel = await openComputer(page);
    const opened = activityRows(page).filter({ hasText: "Opened page" });
    await expect(opened).toHaveCount(1);
    await expect(opened).toContainText(`${SITE}/`);
    await expect(panel.getByText(/^Nothing yet/)).toHaveCount(0);
    await shot("activity-after-reload");
  });
});
