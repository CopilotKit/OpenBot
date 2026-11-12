import { SITE } from "../site/site";
import {
  activityRows,
  CLOCK,
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
 * THE BOT'S COMPUTER, MANY STEPS IN ONE GO. A Bot fills in a form and sends it from one request:
 * every field and click runs, the form arrives filled in, and each step is listed in Activity with
 * its time, with none stopped short.
 */

const site = serveSite();

test("a Bot fills in a form in one go, and every step shows in Activity", async ({
  page,
  shot,
  makeBot,
}) => {
  test.setTimeout(400_000);
  const botId = await makeBot(
    "Fernhill Helper",
    "Fill in forms on garden shop websites for me. Keep replies short.",
  );
  const before = site().applications.length;
  let channelId = "";

  await test.step("ask for a form to be filled in and sent", async () => {
    await newConversation(page, botId);
    channelId = await send(
      page,
      `Go to ${SITE}/volunteer and fill in the volunteer form for me in one go: full name Robin Okafor, email robin.okafor@example.org, preferred shift Saturday morning, and tick the code of conduct box. Fill in all three fields and tick the box together, in a single step from one snapshot. Then submit it and tell me the reference number in one plain sentence.`,
    );
    await openComputer(page);
    await shot("asked");
  });

  await test.step("every action runs, and the form arrives filled in", async () => {
    await turnOver(page);
    const reply = await replyAfter(page, channelId, 0, /VOL-3172/);
    await expectWholeReply(page, reply);
    await named(page, channelId);
    expect(site().applications.slice(before)).toEqual([
      {
        fullName: "Robin Okafor",
        email: "robin.okafor@example.org",
        shift: "Saturday morning",
        agreed: true,
      },
    ]);
    await shot("sent");
  });

  await test.step("Activity lists every step, each with its time", async () => {
    const rows = activityRows(page);
    for (const field of ["Full name", "Email", "Preferred shift"]) {
      await expect(
        rows.filter({ hasText: "Filled in field" }).filter({ hasText: field }),
      ).toHaveCount(1);
    }
    await expect(
      rows
        .filter({ hasText: "Clicked on page" })
        .filter({ hasText: "I agree to the volunteer code of conduct" }),
    ).toHaveCount(1);
    await expect(
      rows
        .filter({ hasText: "Clicked on page" })
        .filter({ hasText: "Submit application" }),
    ).toHaveCount(1);
    // No step stopped short: none failed, none was left without its time.
    await expect(rows.filter({ hasText: "It did not work." })).toHaveCount(0);
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(6);
    for (let index = 0; index < count; index += 1) {
      await expect(rows.nth(index).locator("time")).toHaveText(CLOCK);
    }
    await shot("activity");
  });
});
