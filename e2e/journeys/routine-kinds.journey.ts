import type { APIRequestContext } from "@playwright/test";
import { expect, type Page, test } from "../harness/test";

/**
 * THE OTHER THINGS NEW ROUTINE MAKES. With a Done when it makes a goal that runs on a schedule until
 * it is met; started when something happens, a goal woken by an event; set to Only tell you, a
 * check-in. Each is listed on Routines with what it is, opens a page of its own, and is removed
 * from there. (A routine on a schedule, with Run now, is routines.journey.ts.)
 *
 * None of these is run here: a goal's Run now is the same run a routine's is, which
 * routines.journey.ts drives on the real model.
 */

const GOAL = "Repot the fern";
const EVENT_GOAL = "Triage new issues";
const CHECK_IN_FOCUS = "Watch for watering reminders I have missed.";

async function removeWhatThisMade(request: APIRequestContext) {
  const goals = await request.get("/api/responsibilities");
  if (goals.ok()) {
    const body = (await goals.json()) as
      | {
          responsibilities?: {
            id: string;
            title: string;
            channelId?: string;
          }[];
        }
      | { id: string; title: string }[];
    const rows = Array.isArray(body) ? body : (body.responsibilities ?? []);
    for (const goal of rows.filter(
      (row) => row.title === GOAL || row.title === EVENT_GOAL,
    )) {
      await request.delete(`/api/responsibilities/${goal.id}`);
    }
  }
  const checkIns = await request.get("/api/proactive/settings");
  if (checkIns.ok()) {
    const body = (await checkIns.json()) as Record<string, unknown>;
    const rows = (Object.values(body).find(Array.isArray) ?? []) as {
      id: string;
      focus?: string | null;
    }[];
    for (const row of rows.filter(
      (setting) => setting.focus === CHECK_IN_FOCUS,
    )) {
      await request.delete(`/api/proactive/settings/${row.id}`);
    }
  }
  // A goal or check-in that is removed keeps the conversation it posted in.
  await deleteConversationsNamed(request, [
    GOAL,
    EVENT_GOAL,
    CHECK_IN_FOCUS.slice(0, 28),
  ]);
}

/** Conversations this journey started (a routine, goal or check-in posts in one of its own), by name. */
async function deleteConversationsNamed(
  request: APIRequestContext,
  names: string[],
) {
  const response = await request.get("/api/channels");
  if (!response.ok()) return;
  const { channels } = (await response.json()) as {
    channels: ({ id: string } & Record<string, unknown>)[];
  };
  for (const channel of channels) {
    const shown = ["title", "name", "summary"]
      .map((field) => channel[field])
      .filter((value): value is string => typeof value === "string");
    if (shown.some((text) => names.some((name) => text.startsWith(name)))) {
      await request.delete(`/api/channels/${channel.id}`);
    }
  }
}

test.afterEach(async ({ request }) => {
  await removeWhatThisMade(request);
});

/** New routine, with the Personal Assistant and what to do filled in. */
async function startNewRoutine(page: Page, instruction: string) {
  const main = page.getByRole("main");
  await page.goto("/routines");
  await main.getByRole("button", { name: "New routine" }).first().click();
  await expect(
    page.getByRole("heading", { name: "New routine", level: 1 }),
  ).toBeVisible();
  await main.getByRole("combobox", { name: "Bot" }).click();
  await page.getByRole("option", { name: "Personal Assistant" }).click();
  await main.getByRole("textbox", { name: "What to do" }).fill(instruction);
}

test("a goal: a routine with Done when, paused, completed and deleted", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const doneWhen = "The fern is in a bigger pot with fresh soil.";

  await test.step("New routine with a Done when makes a goal", async () => {
    await startNewRoutine(
      page,
      "Remind me to repot the fern and check whether it is done.",
    );
    await main.getByRole("combobox", { name: "When" }).click();
    await page.getByRole("option", { name: "Every day", exact: true }).click();
    await main.getByRole("textbox", { name: "Time" }).fill("18:00");
    await main
      .getByRole("textbox", { name: "Done when (optional)" })
      .fill(doneWhen);
    await main.getByRole("textbox", { name: "Name" }).fill(GOAL);
    await shot("new-goal");
    await main.getByRole("button", { name: "Create routine" }).click();
    const row = main.getByRole("link", { name: new RegExp(`^${GOAL}`) });
    await expect(row).toContainText("Goal");
    await expect(row).toContainText(`Until: ${doneWhen}`);
    await shot("goal-listed");
    await row.click();
  });

  await test.step("its page: active, with Run now, Complete and its conversation", async () => {
    await expect(
      page.getByRole("heading", { name: GOAL, level: 1 }),
    ).toBeVisible();
    const active = main.getByRole("switch", { name: "Active" });
    await expect(active).toBeChecked();
    await expect(main.getByRole("button", { name: /^Run now/ })).toBeVisible();
    await expect(main.getByRole("button", { name: /^Complete/ })).toBeVisible();
    await expect(
      main.getByRole("link", { name: /^Open conversation/ }),
    ).toBeVisible();
    await shot("goal-page");

    await active.click();
    await expect(active).not.toBeChecked();
    await expect(main.getByRole("button", { name: /^Run now/ })).toHaveCount(0);
    await shot("goal-paused");
    await active.click();
    await expect(active).toBeChecked();
  });

  await test.step("Complete it", async () => {
    await main.getByRole("button", { name: /^Complete/ }).click();
    await expect(main.getByRole("button", { name: /^Complete/ })).toHaveCount(
      0,
    );
    await shot("goal-completed");
  });

  await test.step("Delete asks first, then removes it", async () => {
    await main.getByRole("button", { name: `Delete the goal ${GOAL}` }).click();
    const dialog = page.getByRole("dialog", { name: `Delete "${GOAL}"?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("link", { name: "Routines", exact: true }).click();
    await expect(
      main.getByRole("link", { name: new RegExp(`^${GOAL}`) }),
    ).toHaveCount(0);
    await shot("goal-deleted");
  });
});

test("a goal started when something happens", async ({ page, shot }) => {
  const main = page.getByRole("main");
  await startNewRoutine(
    page,
    "Label each new issue and say who should look at it.",
  );
  await main.getByRole("combobox", { name: "Starts" }).click();
  await page.getByRole("option", { name: "When something happens" }).click();
  const source = main.getByRole("combobox", { name: "Source" });
  await source.click();
  // The personal edition has no Slack, so it isn't offered as a source.
  await expect(page.getByRole("option", { name: "Slack" })).toHaveCount(0);
  await page.getByRole("option", { name: "GitHub" }).click();
  await expect(
    main.getByText("Events come from the repositories you connected in"),
  ).toBeVisible();
  await main.getByRole("textbox", { name: "Event" }).fill("issues.opened");
  await main.getByRole("textbox", { name: "Name" }).fill(EVENT_GOAL);
  await shot("new-event-goal");
  await main.getByRole("button", { name: "Create routine" }).click();
  const row = main.getByRole("link", { name: new RegExp(`^${EVENT_GOAL}`) });
  await expect(row).toContainText("Goal");
  await shot("event-goal-listed");
  await row.click();
  await expect(
    page.getByRole("heading", { name: EVENT_GOAL, level: 1 }),
  ).toBeVisible();
  await expect(
    main.getByRole("heading", { name: "Events", level: 2 }),
  ).toBeVisible();
  await shot("event-goal-page");
  await main
    .getByRole("button", { name: `Delete the goal ${EVENT_GOAL}` })
    .click();
  await page
    .getByRole("dialog", { name: `Delete "${EVENT_GOAL}"?` })
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByRole("link", { name: "Routines", exact: true }).click();
  await expect(
    main.getByRole("link", { name: new RegExp(`^${EVENT_GOAL}`) }),
  ).toHaveCount(0);
});

test("a check-in: Only tell you, how often, switched off and removed", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  await startNewRoutine(page, CHECK_IN_FOCUS);
  await main.getByRole("combobox", { name: "It should" }).click();
  await page.getByRole("option", { name: "Only tell you" }).click();
  await expect(
    main.getByRole("heading", { name: "How often it looks", level: 2 }),
  ).toBeVisible();
  const often = main.getByRole("combobox", { name: "How often" });
  await often.click();
  await page.getByRole("option", { name: "Once a day" }).click();
  await expect(often).toHaveText(/Once a day/);
  // Only tell you is never done, so it has no Done when.
  await expect(
    main.getByRole("textbox", { name: "Done when (optional)" }),
  ).toHaveCount(0);
  await shot("new-check-in");
  await main.getByRole("button", { name: "Create routine" }).click();

  const row = main.getByRole("link").filter({ hasText: "Check-in" }).filter({
    hasText: "Personal Assistant",
  });
  await expect(row).toBeVisible();
  await shot("check-in-listed");
  await row.click();

  const on = main.getByRole("switch", { name: "Check-ins on" });
  await expect(on).toBeChecked();
  await shot("check-in-page");
  await on.click();
  await expect(on).not.toBeChecked();
  await on.click();
  await expect(on).toBeChecked();

  await main.getByRole("button", { name: /^Remove check-in/ }).click();
  const dialog = page.getByRole("dialog", { name: "Remove this check-in?" });
  await expect(dialog).toBeVisible();
  await shot("check-in-remove-asks");
  await dialog.getByRole("button", { name: /^Remove/ }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("link", { name: "Routines", exact: true }).click();
  await expect(
    main.getByRole("link").filter({ hasText: "Check-in" }),
  ).toHaveCount(0);
});
