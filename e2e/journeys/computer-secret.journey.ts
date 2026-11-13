import { MEMBER, SITE } from "../site/site";
import { approvalCard } from "./approval-steps";
import {
  activityRows,
  computerPanel,
  expect,
  expectEveryRowTimed,
  expectWholeReply,
  named,
  newConversation,
  openComputer,
  replyAfter,
  send,
  serveSite,
  test,
  turnOver,
} from "./computer-steps";

/**
 * THE BOT'S COMPUTER, A PASSWORD THROUGH THE MASKED BOX. A Bot that needs one value it must not be
 * told asks for it with `computer_request_secret`, naming the field by its ref. The person types it
 * into a masked box beside the Bot's screen, it goes straight into the field, and the Bot signs in
 * and carries on. Nothing is handed over: the Bot never clicks the password field, which the gate
 * hands to the person (server/src/approvals/policy.ts), and the password never reaches the Bot.
 */

const site = serveSite();

test("a Bot asks for a password in the masked box and signs in without handing the browser over", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(400_000);
  const botId = await makeBot(
    "Fernhill Keeper",
    "Look after my Fernhill Garden Supply members' account. Keep replies short.",
  );
  const before = site().signIns.length;
  let channelId = "";
  const masked = computerPanel(page).getByLabel(/^The Bot needs/);

  await test.step("the Bot fills in the username and asks for the password in the masked box", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Open ${SITE}/members and fill in my username ${MEMBER.username}. Ask me for my password with the masked box, so it goes straight into the page and you never see it. Then sign in and tell me my seed allowance in one plain sentence.`,
    );
    await openComputer(page);
    await expect(masked).toBeVisible({ timeout: 120_000 });
    // Asked for, not handed over: no card waits on the person, and nothing is signed in yet.
    await expect(approvalCard(page)).toHaveCount(0);
    await expect(
      activityRows(page)
        .filter({ hasText: "Filled in field" })
        .filter({ hasText: "Username" }),
    ).toHaveCount(1);
    expect(site().signIns.slice(before)).toEqual([]);
    await shot("asks-for-the-password");
  });

  await test.step("the person types it into the masked box, and the Bot signs in and answers", async () => {
    await masked.fill(MEMBER.password);
    await computerPanel(page)
      .getByRole("button", { name: "Send to the page" })
      .click();
    await expect(masked).toBeHidden({ timeout: 60_000 });
    const reply = await replyAfter(page, channelId, 0, /12 packets/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    expect(site().signIns.slice(before)).toEqual([
      { username: MEMBER.username, ok: true },
    ]);
    // The password went from the person's keyboard to the page, never into the conversation.
    expect(reply).not.toContain(MEMBER.password);
    await shot("signed-in");
  });

  await test.step("no step was handed over, and Activity lists every one with its time", async () => {
    await expect(approvalCard(page)).toHaveCount(0);
    const rows = activityRows(page);
    await expect(rows.filter({ hasText: "You did it yourself." })).toHaveCount(
      0,
    );
    await expect(
      rows
        .filter({ hasText: "Clicked on page" })
        .filter({ hasText: "Password" }),
    ).toHaveCount(0);
    await expectEveryRowTimed(page);
    await shot("activity");
  });
});
