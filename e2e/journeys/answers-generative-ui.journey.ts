import { expect, test } from "../harness/test";
import {
  answerOf,
  expectSettled,
  generatedName,
  send,
  type ThreadEvent,
  transcript,
} from "./chat";

/**
 * ANSWERS THE BOT DRAWS: a bar chart and then a metric card the Personal Assistant puts in the
 * conversation, each a component of OpenBot's own rather than words, drawn again from the
 * conversation's history after a reload. And the home page's starter chips, one of which asks for an
 * interactive budget the person can edit.
 */

const CHART_REQUEST =
  "Show my garden's monthly rainfall as a bar chart: January 78 mm, February 52 mm, March 61 mm, April 45 mm. Draw only the chart, then say one short sentence.";
const CARD_REQUEST =
  "Now show the four-month rainfall total as a single metric card, then say one short sentence.";

/** The tools the runs in `events` called, in order. */
function drawn(events: ThreadEvent[]): string[] {
  return events
    .filter((event) => event.type === "TOOL_CALL_START")
    .map((event) => event.toolCallName ?? "");
}

/**
 * A Bot draws with one of OpenBot's own components (`showBarChart`, `showMetrics`, …), which the
 * browser draws, or with an interface it lays out itself (`render_ui`), which the server checks and
 * streams. Either is a drawn answer; which one the model reached for is in the recording.
 */
const DRAWS_A_CHART = ["showBarChart", "render_ui"];
const DRAWS_A_CARD = ["showMetrics", "showRecord", "render_ui"];

test("a person gets a chart, a card and an interactive answer", async ({
  page,
  shot,
}) => {
  const log = transcript(page);
  // The chart has a bar for every month; the card, the total.
  const chart = log
    .getByRole("figure")
    .filter({ hasText: "February" })
    .filter({ hasText: "March" });
  const card = log.getByRole("figure").filter({ hasText: "236" });
  let channelId = "";

  await test.step("a bar chart, drawn in the conversation", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await send(page, CHART_REQUEST);
    const answer = await answerOf(page);
    channelId = answer.channelId;
    const tools = drawn(answer.events);
    expect(tools).toHaveLength(1);
    expect(DRAWS_A_CHART).toContain(tools[0]);
    await expect(chart).toBeVisible();
    for (const month of ["January", "February", "March", "April"])
      await expect(chart).toContainText(month);
    await expectSettled(chart);
    await chart.scrollIntoViewIfNeeded();
    await shot("bar-chart");
  });

  await test.step("then a metric card with the total", async () => {
    const before = (await answerOf(page)).runs;
    await send(page, CARD_REQUEST);
    const answer = await answerOf(page, before);
    const tools = drawn(answer.events);
    expect(tools).toHaveLength(1);
    expect(DRAWS_A_CARD).toContain(tools[0]);
    await expect(card).toBeVisible();
    await expect(card).toContainText("mm");
    await expectSettled(card);
    await card.scrollIntoViewIfNeeded();
    await shot("metric-card");
    await generatedName(page, channelId);
  });

  await test.step("both are drawn again from history after a reload", async () => {
    await page.reload();
    await expect(log.getByText(CHART_REQUEST, { exact: true })).toBeVisible();
    await expect(chart).toBeVisible();
    await expect(card).toBeVisible();
    await expect(chart).toContainText("April");
    await chart.scrollIntoViewIfNeeded();
    await shot("after-reload");

    // The rail beside the transcript jumps between the conversation's turns.
    const turns = page.getByRole("navigation", { name: "Turns" });
    await turns.getByRole("button", { name: CARD_REQUEST }).click();
    await expect(log.getByText(CARD_REQUEST, { exact: true })).toBeInViewport();
    await turns.getByRole("button", { name: CHART_REQUEST }).click();
    await expect(
      log.getByText(CHART_REQUEST, { exact: true }),
    ).toBeInViewport();
  });

  await test.step("the starter chips: on the person's first conversation", async () => {
    // Home offers them until the first conversation; from then on they live in that one.
    const { preferences } = (await (
      await page.request.get("/api/settings/preferences")
    ).json()) as { preferences: { starterTourChannelId?: string } };
    const tour = preferences.starterTourChannelId;
    expect(tour, "the first conversation holds the starter tour").toBeTruthy();
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Starter tasks" }),
    ).toHaveCount(0);

    await page.goto(`/channel/${tour}`);
    const starters = page.getByRole("region", { name: "Starter tasks" });
    for (const chip of [
      "Chart Hacker News",
      "Browse Google Maps",
      "Triage my inbox",
      "Build a trip budget",
    ]) {
      await expect(starters.getByRole("button", { name: chip })).toBeVisible();
    }
    await shot("starter-chips");
  });

  await test.step("the trip budget chip: an interface the person can edit", async () => {
    const before = (await answerOf(page)).runs;
    await page
      .getByRole("region", { name: "Starter tasks" })
      .getByRole("button", { name: "Build a trip budget" })
      .click();
    await expect(
      log.getByText(/^Build an interactive weekend trip budget/),
    ).toBeVisible();
    const answer = await answerOf(page, before);
    expect(drawn(answer.events)).toContain("render_ui");
    const budget = log
      .getByRole("list")
      .filter({ has: page.getByRole("spinbutton") })
      .last();
    const transport = budget.getByRole("spinbutton", { name: /^Transport/ });
    await expect(transport).toHaveValue("100");
    await expect(
      budget.getByRole("spinbutton", { name: /^Lodging/ }),
    ).toHaveValue("200");
    await expect(budget.getByRole("spinbutton", { name: /^Food/ })).toHaveValue(
      "80",
    );
    await expect(log.getByText("$380", { exact: true })).toBeVisible();
    await budget.scrollIntoViewIfNeeded();
    await shot("trip-budget");

    // Edited, the total follows at once, and the slider with it.
    await transport.fill("150");
    await expect(log.getByText("$430", { exact: true })).toBeVisible();
    await expect(
      budget.getByRole("slider", { name: /^Transport/ }),
    ).toHaveValue("150");
    await shot("trip-budget-edited");
  });
});
