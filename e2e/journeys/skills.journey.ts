import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../harness/test";

/**
 * SKILLS AND TEACH A BOT: the skills a person's Bots offer, writing one, turning it off for a Bot,
 * changing it and deleting it; whether new skills wait for review; and the Teach a Bot screen.
 *
 * Recording a task (Record on Teach a Bot) drives the person's own browser, which the end-to-end
 * stack runs without (`OPENBOT_PERSON_BROWSER=off`); it is not done here. Learn now asks
 * Intelligence's own models to read recordings, which Learning being off for the run rules out.
 *
 * The skill this writes is deleted before it ends, because every Bot's skill chooser lists the
 * skills there are, and the next journey's model calls would read it.
 */

const TITLE = "Plant care log";
const COMMAND = "plant-care-log";

async function removeWhatThisMade(request: APIRequestContext) {
  // Answers 404 when the journey already deleted it, which is the usual case.
  await request.delete(`/api/plugins/skills/${COMMAND}`);
}

test.afterEach(async ({ request }) => {
  await removeWhatThisMade(request);
});

test("a person writes a skill, turns it off for a Bot, changes it and deletes it", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const skill = main.getByRole("link", { name: new RegExp(`^${TITLE}`) });

  await test.step("Skills: the ones every Bot offers", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Skills" }).click();
    await expect(
      page.getByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByRole("heading", { name: "Your skills", level: 2 }),
    ).toBeVisible();
    for (const name of ["Find a document", "Make a Bot", "Write a skill"]) {
      await expect(
        main.getByRole("link", { name: new RegExp(`^${name} Written`) }),
      ).toBeVisible();
    }
    await shot("skills");
  });

  await test.step("new skills: approved automatically, or waiting for review", async () => {
    const auto = main.getByRole("switch", {
      name: "Approve new skills automatically",
    });
    await expect(auto).toBeChecked();
    await auto.click();
    await expect(auto).not.toBeChecked();
    await page.reload();
    await expect(
      main.getByRole("switch", { name: "Approve new skills automatically" }),
    ).not.toBeChecked();
    await shot("skills-review-first");
    await main
      .getByRole("switch", { name: "Approve new skills automatically" })
      .click();
    await expect(
      main.getByRole("switch", { name: "Approve new skills automatically" }),
    ).toBeChecked();
    await expect(main.getByRole("button", { name: "Learn now" })).toBeVisible();
  });

  await test.step("New skill: Save says what's missing, then saves", async () => {
    await main.getByRole("button", { name: "New skill" }).click();
    await expect(
      page.getByRole("heading", { name: "New skill", level: 1 }),
    ).toBeVisible();
    const save = main.getByRole("button", { name: "Save skill" });
    await save.click();
    await expect(page).toHaveURL(/\/skills\/new$/);
    await expect(main.getByRole("textbox", { name: "Title" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await shot("new-skill-missing");
    await main.getByRole("textbox", { name: "Title" }).fill(TITLE);
    const command = main.getByRole("textbox", { name: "Command" });
    await command.fill(COMMAND);
    await main
      .getByRole("textbox", { name: "One-liner" })
      .fill("Keeps a running log of watering and repotting");
    await main
      .getByRole("textbox", { name: "Instructions" })
      .fill(
        "Write down what the person did for their plants today, with the date, then list what is due next.",
      );
    await expect(
      main.getByRole("heading", { name: "Tools", level: 2 }),
    ).toBeVisible();
    await expect(save).toBeEnabled();
    await shot("new-skill");
    await save.click();
    await expect(
      page
        .getByRole("heading", { name: "Skills", level: 1 })
        .or(page.getByRole("heading", { name: TITLE, level: 1 })),
    ).toBeVisible();
    if (
      await page.getByRole("heading", { name: "Skills", level: 1 }).isVisible()
    ) {
      await expect(skill).toBeVisible();
      await shot("skill-listed");
      await skill.click();
    }
    await expect(
      page.getByRole("heading", { name: TITLE, level: 1 }),
    ).toBeVisible();
  });

  const offers = main.getByRole("switch", {
    name: `Personal Assistant offers ${TITLE}`,
  });

  await test.step("its page: which Bots offer it, switched off and on", async () => {
    await expect(main.getByRole("textbox", { name: "Command" })).toBeDisabled();
    await expect(main.getByRole("textbox", { name: "Command" })).toHaveValue(
      COMMAND,
    );
    await expect(offers).toBeChecked();
    await shot("skill-page");
    await offers.click();
    await expect(offers).not.toBeChecked();
    await page.reload();
    await expect(offers).not.toBeChecked();
    await offers.click();
    await expect(offers).toBeChecked();
  });

  await test.step("change it", async () => {
    const oneLiner = main.getByRole("textbox", { name: "One-liner" });
    await oneLiner.fill("Logs watering and repotting, then says what is due");
    await main.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Skill saved")).toBeVisible();
    await page.reload();
    await expect(main.getByRole("textbox", { name: "One-liner" })).toHaveValue(
      "Logs watering and repotting, then says what is due",
    );
    await shot("skill-changed");
  });

  await test.step("Delete asks first, then removes it", async () => {
    await main
      .getByRole("button", { name: /^Delete People can't run it/ })
      .click();
    const dialog = page.getByRole("dialog", { name: `Delete ${TITLE}?` });
    await expect(dialog).toBeVisible();
    await shot("skill-delete-asks");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await main
      .getByRole("button", { name: /^Delete People can't run it/ })
      .click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Skills", level: 1 }),
    ).toBeVisible();
    await expect(skill).toHaveCount(0);
    await shot("skill-deleted");
  });
});

test("a person opens Teach a Bot from Skills", async ({ page, shot }) => {
  const main = page.getByRole("main");
  await page.goto("/skills");
  await expect(
    main.getByRole("heading", { name: "Teach a Bot", level: 2 }),
  ).toBeVisible();
  await main.getByRole("link", { name: /^Record a task/ }).click();
  await expect(
    page.getByRole("heading", { name: "Teach a Bot", level: 1 }),
  ).toBeVisible();
  await expect(main.getByRole("textbox", { name: "Address" })).toBeVisible();
  await expect(main.getByRole("button", { name: "Record" })).toBeVisible();
  await expect(main.getByRole("tab", { name: "New tab" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    main.getByRole("heading", { name: "Your recordings", level: 2 }),
  ).toBeVisible();
  await expect(
    main.getByText("No recordings yet. Each task you record shows up here."),
  ).toBeVisible();
  await shot("teach-a-bot");
  await main.getByRole("link", { name: "See what your Bots learned" }).click();
  await expect(
    page.getByRole("heading", { name: "Skills", level: 1 }),
  ).toBeVisible();
});
