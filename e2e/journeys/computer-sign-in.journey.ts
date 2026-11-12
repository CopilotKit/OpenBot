import { MEMBER, SITE } from "../site/site";
import { answer, approvalCard, HANDED_OVER } from "./approval-steps";
import {
  activityRows,
  expect,
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
 * THE BOT'S COMPUTER, A SIGN-IN HANDED TO THE PERSON. A password is the person's to type, so a Bot
 * that reaches a password field hands that step over (server/src/approvals/policy.ts, a credential
 * typed on a website). The person takes control of the Bot's browser, types the password into the
 * page themselves, hands the browser back and answers "I did it myself"; the Bot carries on from the
 * signed-in page. The password goes from the person's keyboard to the page, never to the Bot.
 */

const site = serveSite();

const HANDED = "needs you to type it, so it's yours to do.";

test("a password is handed to the person, who signs in and hands the browser back", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(400_000);
  const botId = await makeBot(
    "Fernhill Member",
    "Look things up in my Fernhill Garden Supply members' area. Keep replies short.",
  );
  const before = site().signIns.length;
  let channelId = "";

  await test.step("the Bot fills in the username and hands the password to the person", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Open ${SITE}/members, fill in my username ${MEMBER.username}, then hand me the browser so I can type my password myself. After I hand it back, tell me my seed allowance in one plain sentence.`,
    );
    const card = approvalCard(page);
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText("Password");
    await expect(card).toContainText(HANDED);
    for (const choice of HANDED_OVER) {
      await expect(card.getByRole("radio", { name: choice })).toBeVisible();
    }
    // Nobody can allow a password for the person: there is no standing answer to give.
    await expect(
      card.getByRole("radio", { name: "Always allow here" }),
    ).toHaveCount(0);
    await expect(
      activityRows(page)
        .filter({ hasText: "Filled in field" })
        .filter({ hasText: "Username" }),
    ).toHaveCount(1);
    expect(site().signIns.slice(before)).toEqual([]);
    await shot("password-handed-over");
  });

  const view = page.getByRole("dialog", { name: "The Bot's screen" });

  await test.step("take control and sign in on the Bot's screen", async () => {
    const panel = await openComputer(page);
    await panel.getByRole("button", { name: "Take control" }).click();
    await expect(view).toBeVisible();
    await expect(view.getByRole("textbox", { name: "Address" })).toHaveValue(
      `${SITE}/members`,
    );
    const screen = view.getByRole("application");
    await expect(screen).toBeVisible();
    // The username field has the focus: Tab to the password, type it, and send the form.
    await screen.press("Tab");
    await screen.pressSequentially(MEMBER.password);
    await screen.press("Enter");
    await expect(view.getByRole("tab", { selected: true })).toHaveText(
      "Members area",
    );
    expect(site().signIns.slice(before)).toEqual([
      { username: MEMBER.username, ok: true },
    ]);
    await shot("signed-in-by-the-person");
    await view.getByRole("button", { name: "Hand back" }).click();
    await expect(
      view.getByRole("button", { name: "Take control" }),
    ).toBeVisible();
    await view.getByRole("button", { name: "Close the Bot's screen" }).click();
    await expect(view).toBeHidden();
  });

  await test.step("I did it myself: the Bot carries on from the signed-in page", async () => {
    const mark = await answer(page, channelId, "I did it myself");
    const reply = await replyAfter(page, channelId, mark, /12 packets/);
    await turnOver(page);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    // The Bot read the page the person signed in to; it did not sign in again.
    expect(site().signIns.slice(before)).toHaveLength(1);
    await shot("carried-on");
  });
});
