import { expect, test } from "../harness/test";
import {
  answerOf,
  conversationRow,
  expectSettled,
  generatedName,
  send,
  transcript,
} from "./chat";

/**
 * CREATING A BOT, every field the New Bot sheet has and every way it says no: an empty name, the
 * custom-agent path with no address, a malformed one and one the server cannot reach, Back, and
 * Cancel. Then a Bot made for real, on its profile and the Bots list, and a first conversation
 * with it whose answer follows the instructions it was given.
 *
 * Connecting a custom agent for real needs an AG-UI agent the server can dial, which this stack
 * does not run: the sheet's custom-agent path is driven up to the server's "could not reach" answer.
 */

const BOT = "Allotment Planner";
const INSTRUCTIONS =
  "You plan small vegetable allotments. Answer in at most three short sentences, then end every reply with the exact words: Happy growing!";
const QUESTION =
  "Which three vegetables suit a two square metre allotment bed in partial shade?";

test("a person creates a Bot and talks to it", async ({ page, shot }) => {
  const main = page.getByRole("main");
  const sheet = page.getByRole("dialog", { name: "New Bot" });
  const name = sheet.getByRole("textbox", { name: "Name" });
  const create = sheet.getByRole("button", { name: "Create Bot" });

  await test.step("the New Bot sheet opens empty, and Cancel closes it", async () => {
    await page.goto("/bots");
    await main.getByRole("button", { name: "New Bot" }).click();
    await expect(page).toHaveURL(/\/bots\?new=true$/);
    await expect(sheet).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("");
    await expect(
      sheet.getByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("");
    await expect(create).toBeDisabled();
    await expect(
      sheet.getByRole("group", { name: "Apps it can use" }),
    ).toContainText("Every Bot can use every app you turn on in Connections.");
    await expect(
      sheet
        .getByRole("list", { name: "Apps it can use" })
        .getByRole("listitem")
        .first(),
    ).toBeVisible();
    await shot("new-bot-sheet");

    // A name of spaces is no name.
    await name.fill("   ");
    await expect(create).toBeDisabled();

    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/bots$/);
  });

  await test.step("the custom-agent path, and each way it refuses", async () => {
    await main.getByRole("button", { name: "New Bot" }).click();
    await expect(name).toHaveValue("");

    // Without a name it asks for one, on the field.
    const custom = sheet.getByRole("button", { name: /^Bring your own agent/ });
    await custom.click();
    await expect(sheet.getByRole("alert")).toHaveText("Name is required.");
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await shot("name-required");

    await name.fill(`${BOT} Remote`);
    await custom.click();
    await expectSettled(
      sheet.getByRole("heading", { name: "Connect a custom agent" }),
    );
    for (const framework of [
      "An agent you already run",
      "Claude Agent SDK",
      "LangChain",
      "CrewAI",
      "Pydantic AI",
    ]) {
      await expect(
        sheet.getByRole("button", { name: new RegExp(`^${framework} `) }),
      ).toBeVisible();
    }
    await shot("custom-agent-frameworks");

    await sheet
      .getByRole("button", { name: /^An agent you already run / })
      .click();
    await expectSettled(
      sheet.getByRole("heading", { name: "Where can it be reached?" }),
    );
    const address = sheet.getByRole("textbox", { name: "Agent address" });
    await expect(address).toBeFocused();
    await expect(sheet.getByRole("textbox", { name: /^Key/ })).toHaveAttribute(
      "type",
      "password",
    );

    await create.click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "Enter your agent's address.",
    );
    await address.fill("not a web address");
    await create.click();
    await expect(sheet.getByRole("alert")).toHaveText(
      "Enter a web address starting with http:// or https://.",
    );
    // Nothing listens on the discard port: the server says it could not reach it.
    await address.fill("http://127.0.0.1:9/ag-ui");
    await create.click();
    await expect(sheet.getByRole("alert")).toContainText(
      "This server could not reach that address.",
    );
    await expect(address).toHaveAttribute("aria-invalid", "true");
    await shot("custom-agent-unreachable");

    // Back twice: the frameworks, then the first step with the name still there.
    await sheet.getByRole("button", { name: "Back" }).click();
    await expect(
      sheet.getByRole("heading", { name: "Connect a custom agent" }),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Back" }).click();
    await expect(name).toHaveValue(`${BOT} Remote`);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    // Nothing was made.
    await expect(
      main.getByRole("link", { name: new RegExp(`^${BOT}`) }),
    ).toHaveCount(0);
  });

  await test.step("a Bot made with a name and instructions", async () => {
    await main.getByRole("button", { name: "New Bot" }).click();
    await name.fill(BOT);
    await sheet
      .getByRole("textbox", { name: /^Instructions/ })
      .fill(INSTRUCTIONS);
    await expect(create).toBeEnabled();
    await shot("new-bot-filled");
    await create.click();

    await expectSettled(
      sheet.getByRole("heading", { name: `${BOT} is ready` }),
    );
    await expect(sheet.getByRole("status")).toContainText("Taking you to it…");
    await shot("bot-ready");

    // It lands on the new Bot's profile, which says what it is and what it was told.
    await expect(page).toHaveURL(/\/bots\/agent_[0-9a-f-]+$/);
    await expect(
      main.getByRole("heading", { name: BOT, level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByText("Powered by OpenBot", { exact: true }),
    ).toBeVisible();
    await expect(main.getByText(INSTRUCTIONS)).toBeVisible();
    await expect(main.getByRole("switch", { name: "Active" })).toBeChecked();
    await expect(
      main.getByRole("link", { name: /^Skills \d+ skills?/ }),
    ).toBeVisible();
    await expect(main.getByRole("link", { name: /^Activity / })).toBeVisible();
    await shot("bot-profile");

    // Its Setup shows what the sheet's Instructions became: what it does, which it runs on.
    await main.getByRole("link", { name: /^Setup / }).click();
    await expect(
      main.getByRole("button", { name: `Name ${BOT}` }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Title Powered by OpenBot" }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: `What it does ${INSTRUCTIONS}` }),
    ).toBeVisible();
    await expect(main.getByText("Built in", { exact: true })).toBeVisible();
    await shot("bot-setup");
    await main.getByRole("button", { name: BOT, exact: true }).click();
  });

  await test.step("the Bots list has it under Yours", async () => {
    await main.getByRole("button", { name: "Bots", exact: true }).click();
    await expect(
      main.getByRole("heading", { name: "Yours", level: 2 }),
    ).toBeVisible();
    const row = main.getByRole("link", { name: new RegExp(`^${BOT} ${BOT}`) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Powered by OpenBot");
    await shot("bots-list-with-it");
    await row.click();
    await expect(
      main.getByRole("heading", { name: BOT, level: 1 }),
    ).toBeVisible();
  });

  await test.step("a first conversation with it follows its instructions", async () => {
    await main
      .getByRole("link", { name: `Message ${BOT} Start a conversation.` })
      .click();
    await expect(page).toHaveURL(/\/channel\/new\?agent=agent_/);
    // Addressed to it already.
    await expect(
      page.getByRole("button", { name: `Remove ${BOT}` }),
    ).toBeVisible();
    await shot("new-conversation-to-it");

    await send(page, QUESTION);
    const { answer, channelId } = await answerOf(page);
    expect(answer, "it ends as its instructions say").toMatch(
      /Happy growing!\s*$/,
    );
    await expect(
      transcript(page).getByText(QUESTION, { exact: true }),
    ).toBeVisible();
    await expect(transcript(page)).toContainText("Happy growing!");
    // The conversation is its, by name, at the top of the header and in the sidebar.
    await expect(
      page
        .locator('[data-slot="conversation-header"]')
        .getByText(BOT, { exact: true }),
    ).toBeVisible();
    await shot("answer-from-it");

    // OpenBot names it, and the sidebar shows the name under the Bot's.
    const named = await generatedName(page, channelId);
    const row = conversationRow(page, named);
    await expect(row).toHaveAttribute("href", `/channel/${channelId}`);
    await expect(row).toContainText(BOT);
    await shot("conversation-named");
  });
});
