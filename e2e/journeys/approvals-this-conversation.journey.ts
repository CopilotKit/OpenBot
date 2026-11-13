import { SITE, SITE_HOST } from "../site/site";
import {
  allowances,
  answer,
  approvalCard,
  expectAsksToPay,
} from "./approval-steps";
import {
  activityRows,
  expect,
  expectEveryRowTimed,
  expectWholeReply,
  named,
  newConversation,
  openComputer,
  replyAfter,
  runsSoFar,
  send,
  serveSite,
  test,
  turnOver,
} from "./computer-steps";

/**
 * APPROVALS, ALLOW FOR THIS CONVERSATION. The first order asks; allowed for the conversation, the
 * next order there goes through with no card, and the banner above the composer says what is
 * allowed. Turned off there, the next order asks again.
 */

const site = serveSite();

test("Allow for this conversation lets the next order through, until it is turned off", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(500_000);
  const botId = await makeBot(
    "Fernhill Shopper",
    "Order seeds for me from the Fernhill Garden Supply website. Keep replies short.",
  );
  const before = site().orders.length;
  const ordered = () => site().orders.slice(before);
  let channelId = "";

  await test.step("the first order asks; allow it for this conversation", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Please buy the sunflower seeds at ${SITE}/shop/sunflower and give me the order number in one sentence.`,
    );
    await expectAsksToPay(page);
    await shot("asks");
    const mark = await answer(page, channelId, "Allow for this conversation");
    const reply = await replyAfter(page, channelId, mark, /FH-2044/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    expect(ordered()).toEqual(["sunflower"]);
    // Activity says how the order was allowed, as it says when one is declined.
    await openComputer(page);
    await expect(
      activityRows(page)
        .filter({ hasText: "Place order" })
        .filter({ hasText: "Allowed for this conversation." }),
    ).toHaveCount(1);
    await expectEveryRowTimed(page);
  });

  const allowed = allowances(page);
  const turnOff = allowed.getByRole("button", { name: /^Turn off: / });

  await test.step("the banner says what this conversation allows", async () => {
    await expect(allowed).toBeVisible();
    await expect(allowed).toContainText(
      `Paying on ${SITE_HOST} is allowed in this conversation.`,
    );
    await expect(turnOff).toHaveCount(1);
    await shot("allowed-for-conversation");
  });

  await test.step("the second order goes through with no card", async () => {
    const mark = await runsSoFar(page, channelId);
    await send(
      page,
      `Great. Please also buy the lavender seeds at ${SITE}/shop/lavender and give me that order number too.`,
    );
    const reply = await replyAfter(page, channelId, mark, /FH-2045/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await expect(approvalCard(page)).toHaveCount(0);
    expect(ordered()).toEqual(["sunflower", "lavender"]);
    await shot("second-order-no-card");
  });

  await test.step("Turn off, and the next order asks again", async () => {
    await turnOff.click();
    await expect(allowed).toHaveCount(0);
    await shot("turned-off");
    await send(
      page,
      `One more, please: the chamomile seeds at ${SITE}/shop/chamomile, with the order number.`,
    );
    await expectAsksToPay(page);
    expect(ordered()).toEqual(["sunflower", "lavender"]);
    await shot("asks-after-turn-off");
    const mark = await answer(page, channelId, "Allow once");
    const reply = await replyAfter(page, channelId, mark, /FH-2046/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    expect(ordered()).toEqual(["sunflower", "lavender", "chamomile"]);
    // Allowed once, not for the conversation: the banner does not come back.
    await expect(allowed).toHaveCount(0);
    await shot("allowed-once-after-turn-off");
  });

  await test.step("after a reload, Activity still says how each order was allowed, and when", async () => {
    await page.reload();
    await openComputer(page);
    const orders = activityRows(page).filter({ hasText: "Place order" });
    await expect(orders).toHaveCount(3);
    await expect(
      orders.filter({ hasText: "Allowed for this conversation." }),
    ).toHaveCount(1);
    await expect(orders.filter({ hasText: "Allowed once." })).toHaveCount(1);
    await expectEveryRowTimed(page);
    await shot("activity-after-reload");
  });
});
