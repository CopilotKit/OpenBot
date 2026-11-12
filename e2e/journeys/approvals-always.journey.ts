import { SITE, SITE_HOST } from "../site/site";
import {
  allowances,
  answer,
  approvalCard,
  expectAsksToPay,
} from "./approval-steps";
import {
  expect,
  expectWholeReply,
  named,
  newConversation,
  replyAfter,
  send,
  serveSite,
  settingsRow,
  test,
  turnOver,
} from "./computer-steps";

/**
 * APPROVALS, ALWAYS ALLOW HERE. The first order asks; always allowed, the Bot pays without asking
 * in its next conversation too, because the answer is a rule. The rule is on the Bot's Approvals
 * page, where the person can remove it.
 */

const site = serveSite();

test("Always allow here lets the Bot pay in its next conversation, until the rule is removed", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(500_000);
  const botId = await makeBot(
    "Fernhill Regular",
    "Keep my garden stocked by ordering from the Fernhill Garden Supply website. Keep replies short.",
  );
  const before = site().orders.length;
  const ordered = () => site().orders.slice(before);

  await test.step("the first order asks; always allow it here", async () => {
    await newConversation(page, botId);
    const channelId = await send(
      page,
      `Order the marigold seeds from ${SITE}/shop/marigold for me, then reply with just the order number.`,
    );
    await expectAsksToPay(page);
    const mark = await answer(page, channelId, "Always allow here");
    const reply = await replyAfter(page, channelId, mark, /FH-2043/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    expect(ordered()).toEqual(["marigold"]);
    // Always is a rule, not this conversation's answer: there is no banner for it here.
    await expect(allowances(page)).toHaveCount(0);
    await shot("always-allowed");
  });

  await test.step("in a new conversation, the Bot pays without asking", async () => {
    await newConversation(page, botId);
    const channelId = await send(
      page,
      `Order the tomato seeds from ${SITE}/shop/tomato for me, then reply with just the order number.`,
    );
    const reply = await replyAfter(page, channelId, 0, /FH-2041/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    await expect(approvalCard(page)).toHaveCount(0);
    expect(ordered()).toEqual(["marigold", "tomato"]);
    await shot("paid-without-asking");
  });

  await test.step("the rule is on the Bot's Approvals page, and Remove takes it away", async () => {
    await page.goto(`/bots/${botId}`);
    await page.getByRole("link", { name: /^Approvals/ }).click();
    await expect(
      page.getByRole("heading", { name: "Approvals", level: 1 }),
    ).toBeVisible();
    const rule = settingsRow(page, SITE_HOST);
    await expect(rule).toHaveCount(1);
    await expect(
      rule.getByRole("combobox", { name: /^Behaviour for / }),
    ).toContainText("Take action without asking");
    await shot("bot-approvals-rule");
    await rule.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No rules for this Bot")).toBeVisible();
    await shot("rule-removed");
  });
});
