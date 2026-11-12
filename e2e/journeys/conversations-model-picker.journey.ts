import { readFileSync } from "node:fs";
import { AIMOCK_LOG } from "../harness/aimock";
import { serverLogMark } from "../harness/runs";
import { expect, type Page, test } from "../harness/test";
import {
  answerOf,
  expectSettled,
  generatedName,
  modelsRunSince,
  send,
  transcript,
} from "./chat";

/**
 * THE MODEL PICKER in the composer: a conversation answers on the default model, a person switches
 * it to another, and the next answer comes from the one chosen, by the server's own record of the
 * run and by the model the request reached. The choice is the conversation's and survives a reload.
 * A model can also be chosen before a conversation starts, and the list can be searched.
 *
 * The models offered are the ones aimock lists: those its fixtures name. This journey's fixtures are
 * recorded on two, gpt-5.6-terra (the Personal Assistant's default) and gpt-4o.
 */

const DEFAULT = "GPT-5.6 Terra";
const OTHER = "GPT-4o";
const ON_DEFAULT =
  "In one short plain sentence, what is the boiling point of water at sea level in Celsius?";
const ON_OTHER =
  "In one short plain sentence, what is the freezing point of water in Fahrenheit?";
const CHOSEN_FIRST =
  "In one short plain sentence, how many minutes are there in one day?";

/** The model a request for `question` reached aimock with, from aimock's own log of it. */
function modelAsked(question: string): string[] {
  const asked = `user="${question.slice(0, 100)}`;
  return readFileSync(AIMOCK_LOG, "utf8")
    .split("\n")
    .filter((line) => line.includes("[e2e] request") && line.includes(asked))
    .map((line) => /model=(\S+)/.exec(line)?.[1] ?? "");
}

function picker(page: Page) {
  return page.getByRole("combobox", { name: /^Model: / });
}

test("a person switches the model a conversation answers on", async ({
  page,
  shot,
}) => {
  let channelId = "";

  await test.step("the first answer comes from the default model", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await expect(picker(page)).toHaveAccessibleName(`Model: ${DEFAULT}`);
    const mark = serverLogMark();
    await send(page, ON_DEFAULT);
    ({ channelId } = await answerOf(page));
    await expect(transcript(page)).toContainText("100");
    expect(modelsRunSince(mark, "personal-assistant")).toEqual([
      "gpt-5.6-terra",
    ]);
    expect(modelAsked(ON_DEFAULT)).toContain("gpt-5.6-terra");
    await generatedName(page, channelId);
  });

  await test.step("the picker lists the models, marks the default, and searches", async () => {
    await picker(page).click();
    const models = page.getByRole("group", { name: "Models" });
    await expect(
      models.getByRole("option", { name: new RegExp(`^${DEFAULT}`) }),
    ).toContainText("Default");
    await expect(
      models.getByRole("option", { name: new RegExp(`^${OTHER}`) }),
    ).toBeVisible();
    await expectSettled(models);
    await shot("model-picker");

    const filter = page
      .getByRole("combobox", { name: "Search models" })
      .or(page.getByPlaceholder("Search models"));
    await filter.fill("4o");
    await expect(
      models.getByRole("option", { name: new RegExp(`^${OTHER}`) }),
    ).toBeVisible();
    await expect(
      models.getByRole("option", { name: new RegExp(`^${DEFAULT}`) }),
    ).toHaveCount(0);
    await filter.fill("no such model");
    await expect(page.getByText("No models match.")).toBeVisible();
    await shot("model-picker-no-match");
    await filter.fill("");
  });

  await test.step("switched, the next answer comes from the model chosen", async () => {
    await page
      .getByRole("group", { name: "Models" })
      .getByRole("option", { name: new RegExp(`^${OTHER}`) })
      .click();
    await expect(picker(page)).toHaveAccessibleName(`Model: ${OTHER}`);
    // Back to writing: the picker hands focus to the message box.
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();

    const mark = serverLogMark();
    await send(page, ON_OTHER);
    await answerOf(page, 1);
    await expect(transcript(page)).toContainText("32");
    expect(modelsRunSince(mark, "personal-assistant")).toEqual(["gpt-4o"]);
    expect(modelAsked(ON_OTHER)).toContain("gpt-4o");
    await shot("answer-from-chosen-model");

    // The conversation keeps its model.
    await page.reload();
    await expect(
      transcript(page).getByText(ON_OTHER, { exact: true }),
    ).toBeVisible();
    await expect(picker(page)).toHaveAccessibleName(`Model: ${OTHER}`);
  });

  await test.step("a model chosen before the conversation starts", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await expect(picker(page)).toHaveAccessibleName(`Model: ${DEFAULT}`);
    await picker(page).click();
    await page
      .getByRole("group", { name: "Models" })
      .getByRole("option", { name: new RegExp(`^${OTHER}`) })
      .click();
    await expect(picker(page)).toHaveAccessibleName(`Model: ${OTHER}`);
    const mark = serverLogMark();
    await send(page, CHOSEN_FIRST);
    const started = await answerOf(page);
    await expect(transcript(page)).toContainText(/1,?440/);
    expect(modelsRunSince(mark, "personal-assistant")).toEqual(["gpt-4o"]);
    await expect(picker(page)).toHaveAccessibleName(`Model: ${OTHER}`);
    await generatedName(page, started.channelId);
  });
});
