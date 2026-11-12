import { ITEMS, SITE } from "../site/site";
import { answer, approvalCard, expectAsksToPay } from "./approval-steps";
import {
  expect,
  expectWholeReply,
  named,
  newConversation,
  replyAfter,
  runsSoFar,
  send,
  serveSite,
  settingsRow,
  test,
  turnOver,
} from "./computer-steps";

/**
 * APPROVALS, ALLOW ONCE AND DENY. A Bot about to pay asks first; Allow once places that order and
 * no other, so the next order asks again. That one also waits on the Bots page under Needs you,
 * the same request as the card; Deny there places nothing, and the Bot says so.
 */

const site = serveSite();

test("Allow once places one order and the next one asks again; Deny buys nothing", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(400_000);
  const botId = await makeBot(
    "Fernhill Buyer",
    "Buy garden supplies for me on the Fernhill Garden Supply website. Keep replies short.",
  );
  const before = site().orders.length;
  const ordered = () => site().orders.slice(before);
  let channelId = "";

  await test.step("the Bot asks before it pays", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Open ${SITE}/shop/tomato and place the order for the tomato seeds. Then tell me the order number in one short sentence.`,
    );
    await expectAsksToPay(page);
    expect(ordered(), "nothing is bought before the person answers").toEqual(
      [],
    );
    await shot("asks-before-paying");
  });

  await test.step("Allow once: the order is placed, and the reply arrives whole", async () => {
    const mark = await answer(page, channelId, "Allow once");
    const reply = await replyAfter(page, channelId, mark, /FH-2041/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    expect(ordered()).toEqual(["tomato"]);
    await shot("allowed-once");
  });

  await test.step("the next order asks again, on the Bots page too; Deny it there", async () => {
    await send(
      page,
      `Now order the basil seeds too, from ${SITE}/shop/basil, and tell me the order number.`,
    );
    await expectAsksToPay(page);
    await shot("asks-again");
    const mark = await runsSoFar(page, channelId);

    // The same request waits on the Bots page, under Needs you, and can be answered there.
    await page.getByRole("link", { name: /^Bots/ }).click();
    const waiting = settingsRow(page, "Fernhill Buyer wants to");
    await expect(waiting).toContainText("Place order");
    await expect(waiting).toContainText(
      "Paying, buying or moving money asks you first.",
    );
    await shot("waiting-on-the-bots-page");
    await waiting.getByRole("button", { name: "Deny" }).click();
    await expect(waiting).toHaveCount(0);

    // Answered there, the conversation's card is gone and the Bot has said what came of it.
    await page.goto(`/channel/${channelId}`);
    const reply = await replyAfter(page, channelId, mark, /declin/i);
    await expect(approvalCard(page)).toHaveCount(0);
    await expectWholeReply(page, reply);
    expect(reply).not.toContain(ITEMS.basil.order);
    expect(ordered(), "a denied order is not placed").toEqual(["tomato"]);
    await shot("denied");
  });
});
