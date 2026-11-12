import { expect, test } from "../harness/test";
import {
  answerOf,
  channelIdOf,
  generatedName,
  send,
  threadEvents,
  transcript,
} from "./chat";

/**
 * A LONG ANSWER, and stopping one: the answer streams in over many screens, the transcript scrolls,
 * and Scroll to end brings it back down; asked again in a new conversation, the person stops the
 * Bot part-way and keeps what it had written, with the composer free again.
 *
 * aimock replays an answer at the pace it was recorded, so the second ask streams for long enough
 * to be stopped. Recording, the second ask is answered from the first ask's recording.
 */

const QUESTION =
  "Write a detailed guide of about 900 words on planning a small vegetable garden through the four seasons, with a level-two heading for each season and three paragraphs under each.";

const QUEUED = "Thanks, that is plenty for now.";

test("a person reads a long answer and stops another part-way", async ({
  page,
  shot,
}) => {
  test.setTimeout(240_000);
  const log = transcript(page);
  let full = "";

  await test.step("a long answer, scrolled through", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await send(page, QUESTION);

    // Written while it answers, a message waits its turn, and can be taken back before it runs.
    await expect(
      log.getByRole("heading", { name: /Spring/, level: 2 }),
    ).toBeVisible({
      timeout: 60_000,
    });
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(QUEUED);
    await page.getByRole("button", { name: "Queue message" }).click();
    const queued = page.getByRole("button", {
      name: `Remove queued message: ${QUEUED}`,
    });
    await expect(queued).toBeVisible();
    await expect(
      log.getByRole("status").filter({ hasText: "Queued" }),
    ).toBeVisible();
    await shot("queued-while-answering");
    await queued.click();
    await expect(queued).toHaveCount(0);

    const { answer, channelId } = await answerOf(page);
    full = answer;
    // The message taken back never ran.
    await expect(log.getByText(QUEUED, { exact: true })).toHaveCount(0);
    expect(full.split(/\s+/).length).toBeGreaterThan(500);
    for (const season of [/Spring/, /Summer/, /Autumn|Fall/, /Winter/]) {
      await expect(
        log.getByRole("heading", { name: season, level: 2 }),
      ).toBeVisible();
    }
    await shot("long-answer-end");
    await generatedName(page, channelId);

    // Up to the question, then Scroll to end brings the last words back.
    await log.getByText(QUESTION, { exact: true }).scrollIntoViewIfNeeded();
    await expect(log.getByText(QUESTION, { exact: true })).toBeInViewport();
    const toEnd = page.getByRole("button", { name: "Scroll to end" });
    await expect(toEnd).toBeVisible();
    await shot("long-answer-top");
    await toEnd.click();
    await expect(
      log.getByRole("heading", { name: /Winter/, level: 2 }),
    ).toBeInViewport();
    await expect(log.getByText(QUESTION, { exact: true })).not.toBeInViewport();
  });

  await test.step("asked again, stopped part-way", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await send(page, QUESTION);
    const stop = page.getByRole("button", { name: "Stop the Bot" });
    await expect(stop).toBeVisible();
    // Once the first season is on screen, stop it.
    await expect(
      log.getByRole("heading", { name: /Spring/, level: 2 }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await stop.click();
    await expect(stop).toBeHidden();
    await shot("stopped");

    // The run ends there: the thread records its end, and what it streamed is part of the whole.
    const channelId = channelIdOf(page);
    let streamed = "";
    let seen = -1;
    await expect
      .poll(
        async () => {
          const events = await threadEvents(page, channelId);
          streamed = events
            .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
            .map((event) => event.delta ?? "")
            .join("");
          // Ended, and every event stored: the same as the read before.
          const settled = events.length === seen;
          seen = events.length;
          return (
            settled &&
            events.some(
              (event) =>
                event.type === "RUN_FINISHED" || event.type === "RUN_ERROR",
            )
          );
        },
        { message: "the stopped run ends" },
      )
      .toBe(true);
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.length).toBeLessThan(full.length);
    expect(full.startsWith(streamed.trim().slice(0, 200))).toBe(true);

    // What it had written stays on screen; the rest never comes; the composer is free.
    await expect(
      log.getByRole("heading", { name: /Spring/, level: 2 }),
    ).toBeVisible();
    await expect(
      log.getByRole("heading", { name: /Winter/, level: 2 }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await shot("stopped-settled");
    await generatedName(page, channelId);
  });
});
