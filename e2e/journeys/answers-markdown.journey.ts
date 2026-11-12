import { readFile } from "node:fs/promises";
import { expect, test } from "../harness/test";
import {
  answerOf,
  expectSettled,
  generatedName,
  send,
  transcript,
} from "./chat";

/**
 * AN ANSWER IN MARKDOWN, drawn as a person reads it: a heading, a bulleted and a numbered list, a
 * table, and a code block. The code block's copy and download, and the table's own controls: copy it
 * as Markdown, CSV or TSV, download it, and view it full screen.
 */

const QUESTION = [
  "Reply with a short markdown reference card about composting and nothing else.",
  "Use exactly: a level-two heading 'Compost basics';",
  "a bulleted list of exactly three green materials;",
  "a numbered list of exactly two steps;",
  "a table with the columns Material and Type and exactly three rows;",
  "and a fenced bash code block containing exactly the one line: echo compost-ready",
].join(" ");
const CODE = "echo compost-ready";

test("a person reads a markdown answer and copies its code", async ({
  page,
  shot,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const log = transcript(page);

  await test.step("ask for a markdown answer", async () => {
    await page.goto("/channel/new?agent=personal-assistant");
    await send(page, QUESTION);
    const { answer, channelId } = await answerOf(page);
    expect(answer).toContain("## Compost basics");
    expect(answer).toContain(CODE);
    await generatedName(page, channelId);
  });

  await test.step("the heading, the lists and the table render as such", async () => {
    await expect(
      log.getByRole("heading", { name: "Compost basics", level: 2 }),
    ).toBeVisible();
    // Three greens and two steps: five items across the two lists.
    const lists = log.getByRole("list");
    await expect(lists).toHaveCount(2);
    await expect(lists.first().getByRole("listitem")).toHaveCount(3);
    await expect(lists.nth(1).getByRole("listitem")).toHaveCount(2);
    await expect(log.locator("ol")).toHaveCount(1);

    const table = log.getByRole("table");
    await expect(
      table.getByRole("columnheader", { name: "Material" }),
    ).toBeVisible();
    await expect(
      table.getByRole("columnheader", { name: "Type" }),
    ).toBeVisible();
    // A header row and three rows.
    await expect(table.getByRole("row")).toHaveCount(4);
    await table.scrollIntoViewIfNeeded();
    await shot("markdown-answer");
  });

  await test.step("the code block, and its copy button", async () => {
    const code = log.locator("pre").filter({ hasText: CODE });
    await expect(code).toBeVisible();
    await code.scrollIntoViewIfNeeded();
    await code.hover();
    const block = log
      .locator('[data-streamdown="code-block"]')
      .filter({ hasText: CODE });
    const copy = block.getByRole("button", { name: "Copy Code" });
    await expect(copy).toBeVisible();
    await shot("code-block");
    await copy.click();
    // The code, and nothing around it but the line's own end.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(new RegExp(`^${CODE}\\n?$`));
  });

  await test.step("the code block's download", async () => {
    const block = log
      .locator('[data-streamdown="code-block"]')
      .filter({ hasText: CODE });
    const download = page.waitForEvent("download");
    await block.getByRole("button", { name: "Download file" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.(sh|bash|txt)$/);
    expect((await readFile(await file.path(), "utf8")).trim()).toBe(CODE);
  });

  await test.step("the table: copy as Markdown, CSV and TSV, download, full screen", async () => {
    const table = log.getByRole("table");
    await table.hover();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    await log.getByRole("button", { name: "Copy table" }).click();
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect.poll(clipboard).toMatch(/^\|\s*Material\s*\|\s*Type\s*\|/);
    await table.hover();
    await log.getByRole("button", { name: "Copy table" }).click();
    await page.getByRole("button", { name: "CSV", exact: true }).click();
    await expect.poll(clipboard).toMatch(/^Material,Type\r?\n/);
    await table.hover();
    await log.getByRole("button", { name: "Copy table" }).click();
    await page.getByRole("button", { name: "TSV", exact: true }).click();
    await expect.poll(clipboard).toMatch(/^Material\tType\r?\n/);

    await table.hover();
    await log.getByRole("button", { name: "Download table" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    // With a byte-order mark, so a spreadsheet opens it as UTF-8.
    expect(await readFile(await file.path(), "utf8")).toMatch(
      /^\uFEFF?Material,Type\r?\n/,
    );

    await table.hover();
    await log.getByRole("button", { name: "View fullscreen" }).click();
    const full = page.getByRole("dialog", { name: "View fullscreen" });
    await expect(full.getByRole("table")).toBeVisible();
    await expect(full.getByRole("row")).toHaveCount(4);
    await expectSettled(full);
    await shot("table-fullscreen");
    await full.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect(full).toBeHidden();
    await expect(table).toBeVisible();
  });
});
