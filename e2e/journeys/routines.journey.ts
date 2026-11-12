import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../harness/test";

/**
 * ROUTINES, every field and every action a person has on a routine that runs on a schedule: New
 * routine with each of its fields, the list, the routine's page, pausing and resuming it, Run now
 * and the answer it posts, its runs, and Delete. Goals and check-ins, the other kinds New routine
 * makes, are routine-kinds.journey.ts.
 *
 * The run is the Personal Assistant's real turn, answered by aimock from fixtures recorded on the
 * real model.
 *
 * NOT HERE: CHANGING A ROUTINE. Its page has no edit; a person changes a routine by asking a Bot,
 * whose `update_routine` call names the routine by its id. A recorded fixture holds the id the
 * routine had in the recording run, and the routine made in a replay has another, so a replayed
 * change would refuse while the transcript, replayed too, says it was made. That would be a test
 * that passes while the product fails, so it is left out until aimock can carry a value from the
 * request into a replayed tool call.
 */

const NAME = "Low-light plants";
const INSTRUCTION =
  "Name three houseplants that grow well in low light, one short line each, no formatting.";
const SECOND = "Seed packets";
const SECOND_INSTRUCTION = "Remind me which seed packets to sow this week.";

type ThreadEvent = { type: string; delta?: string };

/** The routine and the conversation this journey made, removed whether or not it passed. */
async function removeWhatThisMade(request: APIRequestContext) {
  const response = await request.get("/api/routines");
  if (!response.ok()) return;
  const { routines } = (await response.json()) as {
    routines: { id: string; title: string | null; channel: { id: string } }[];
  };
  for (const routine of routines.filter(
    (row) => row.title === NAME || row.title === SECOND,
  )) {
    await request.delete(`/api/routines/${routine.id}`);
  }
  // Deleting a routine keeps the conversation it posted in, which is the person's to delete.
  await deleteConversationsNamed(request, [NAME, SECOND]);
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

/** Everything a conversation's runs streamed as text, from its own events. */
async function streamedText(
  request: APIRequestContext,
  channelId: string,
): Promise<{ text: string; finished: number }> {
  const channel = await request.get(`/api/channels/${channelId}`);
  const { threadId } = (
    (await channel.json()) as { channel: { threadId?: string } }
  ).channel;
  if (!threadId) return { text: "", finished: 0 };
  const response = await request.get(
    `/api/copilotkit/threads/${threadId}/events`,
  );
  if (!response.ok()) return { text: "", finished: 0 };
  const events =
    ((await response.json()) as { events?: ThreadEvent[] }).events ?? [];
  return {
    text: events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta ?? "")
      .join(""),
    finished: events.filter((event) => event.type === "RUN_FINISHED").length,
  };
}

test.afterEach(async ({ request }) => {
  await removeWhatThisMade(request);
});

test("a person creates a routine with every field, pauses it, runs it now and deletes it", async ({
  page,
  shot,
}) => {
  const main = page.getByRole("main");
  const timeZone = await page.evaluate(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  await test.step("Routines, with none yet", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Routines" }).click();
    await expect(
      page.getByRole("heading", { name: "Routines", level: 1 }),
    ).toBeVisible();
    await expect(main.getByText("No routines yet")).toBeVisible();
    await expect(
      main.getByRole("switch", { name: "Check-ins for all your Bots" }),
    ).toBeChecked();
    await shot("routines-empty");
    await main.getByRole("button", { name: "New routine" }).first().click();
    await expect(
      page.getByRole("heading", { name: "New routine", level: 1 }),
    ).toBeVisible();
  });

  await test.step("Create with nothing filled in says what's missing", async () => {
    await main.getByRole("button", { name: "Create routine" }).click();
    await expect(page).toHaveURL(/\/routines\/new$/);
    await expect(main.getByRole("combobox", { name: "Bot" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(
      main.getByRole("textbox", { name: "What to do" }),
    ).toHaveAttribute("aria-invalid", "true");
    await shot("new-routine-missing");
  });

  await test.step("fill in every field", async () => {
    await main.getByRole("combobox", { name: "Bot" }).click();
    await page.getByRole("option", { name: "Personal Assistant" }).click();
    await expect(main.getByRole("combobox", { name: "Bot" })).toHaveText(
      /Personal Assistant/,
    );
    await main.getByRole("textbox", { name: "What to do" }).fill(INSTRUCTION);

    // It should: act, or only tell. Only tell asks how often instead of when.
    const should = main.getByRole("combobox", { name: "It should" });
    await should.click();
    await page.getByRole("option", { name: "Only tell you" }).click();
    await expect(
      main.getByText("It reads and raises what needs you. It changes nothing."),
    ).toBeVisible();
    await expect(
      main.getByRole("combobox", { name: "How often" }),
    ).toBeVisible();
    await shot("new-routine-only-tell");
    await should.click();
    await page.getByRole("option", { name: "Act for you" }).click();

    // Starts: each choice asks its own questions.
    const starts = main.getByRole("combobox", { name: "Starts" });
    await starts.click();
    await page.getByRole("option", { name: "When something happens" }).click();
    await expect(main.getByRole("combobox", { name: "Source" })).toBeVisible();
    await expect(main.getByRole("textbox", { name: "Event" })).toBeVisible();
    await starts.click();
    await page.getByRole("option", { name: "Now, once" }).click();
    await expect(main.getByRole("combobox", { name: "When" })).toHaveCount(0);
    await starts.click();
    await page.getByRole("option", { name: "On a schedule" }).click();

    // When: every week, on a Wednesday, at 07:30.
    await main.getByRole("combobox", { name: "When" }).click();
    await page.getByRole("option", { name: "Every week", exact: true }).click();
    await main.getByRole("combobox", { name: "Day of the week" }).click();
    await page.getByRole("option", { name: "Wednesday" }).click();
    await main.getByRole("textbox", { name: "Time" }).fill("07:30");
    await expect(
      main.getByText(`Every Wednesday at 7:30 AM, your time (${timeZone}).`, {
        exact: false,
      }),
    ).toBeVisible();

    // Done when is left empty: with it, this would be a goal rather than a routine on a schedule
    // (routine-kinds.journey.ts makes one).
    await expect(
      main.getByText(
        "Optional. Leave it empty and it keeps going until you stop it.",
      ),
    ).toBeVisible();
    await expect(
      main.getByRole("textbox", { name: "Done when (optional)" }),
    ).toHaveValue("");

    // Where it posts: a new conversation, or one already shared with the Bot.
    const postsIn = main.getByRole("combobox", { name: "Posts in" });
    await expect(postsIn).toHaveText(/A new conversation/);
    await postsIn.click();
    await expect(
      page.getByRole("option", { name: "A new conversation" }),
    ).toBeVisible();
    await page.getByRole("option", { name: "A new conversation" }).click();
    await main.getByRole("textbox", { name: "Name" }).fill(NAME);
    await shot("new-routine-filled");
  });

  const row = main.getByRole("link", { name: new RegExp(`^${NAME}`) });

  await test.step("Create: it is listed with its Bot and schedule", async () => {
    await main.getByRole("button", { name: "Create routine" }).click();
    await expect(
      page.getByRole("heading", { name: "Routines", level: 1 }),
    ).toBeVisible();
    await expect(row).toBeVisible();
    await expect(row).toContainText(
      "Personal Assistant · Wednesdays at 07:30 · Acts",
    );
    await expect(row).toContainText(INSTRUCTION);
    // It posts in a conversation of its own, named after it.
    await expect(
      page
        .getByRole("navigation")
        .getByRole("link", { name: new RegExp(NAME) })
        .or(page.getByRole("link", { name: new RegExp(`${NAME}$`) }))
        .first(),
    ).toBeVisible();
    await shot("routine-listed");
    await row.click();
  });

  const switchOn = main.getByRole("switch", {
    name: "Enable the routine scheduled Wednesdays at 07:30",
  });
  const runNow = main.getByRole("button", {
    name: "Run the routine scheduled Wednesdays at 07:30 now",
  });
  // A row of Details, by the label it starts with.
  const detail = (label: string) =>
    main
      .locator('[data-slot="item"]')
      .filter({ hasText: new RegExp(`^${label}`) });

  await test.step("its page: on, scheduled, never run", async () => {
    await expect(
      page.getByRole("heading", { name: NAME, level: 1 }),
    ).toBeVisible();
    await expect(
      main.getByText(`Wednesdays at 07:30 · ${timeZone} · Acts`),
    ).toBeVisible();
    await expect(switchOn).toBeChecked();
    await expect(detail("Schedule")).toContainText("Wednesdays at 07:30");
    await expect(detail("Time zone")).toContainText(timeZone);
    await expect(detail("Last run")).toContainText("Hasn't run yet");
    await expect(detail("What to do")).toContainText(INSTRUCTION);
    await expect(main.getByText("No runs yet.")).toBeVisible();
    await shot("routine-page");
  });

  await test.step("pause it, and Run now waits for it to be on again", async () => {
    await switchOn.click();
    await expect(switchOn).not.toBeChecked();
    await expect(
      main.getByText("Paused. Nothing starts it until you turn it on."),
    ).toBeVisible();
    await expect(detail("Next run")).toContainText("Paused");
    await expect(runNow).toBeDisabled();
    await expect(
      main.getByText("This routine is paused. Turn it on first."),
    ).toBeVisible();
    await shot("routine-paused");

    await switchOn.click();
    await expect(switchOn).toBeChecked();
    await expect(runNow).toBeEnabled();
  });

  let channelId = "";

  await test.step("Run now: it succeeds, and nothing still says it is running", async () => {
    await runNow.click();
    const runs = main.locator("section").filter({
      has: page.getByRole("heading", { name: "Runs", level: 2 }),
    });
    await expect(runs.getByText("Succeeded")).toBeVisible({ timeout: 90_000 });
    await expect(runs).toContainText("Run now ·");
    // FOUND BEFORE: "Running…" stayed beside "Succeeded". Once the run is done, nothing says it runs.
    await expect(detail("Last run")).toContainText(/^Last run\s*Ran /);
    await expect(main.getByText("Running…")).toHaveCount(0);
    await expect(main.getByText("Running", { exact: true })).toHaveCount(0);
    await runs.scrollIntoViewIfNeeded();
    await shot("routine-ran");

    const open = main.getByRole("link", { name: /^Open conversation/ }).first();
    channelId = (await open.getAttribute("href"))?.split("/").pop() ?? "";
    expect(channelId).toMatch(/^channel_/);
  });

  await test.step("the answer lands in its conversation", async () => {
    let text = "";
    await expect
      .poll(
        async () => {
          const read = await streamedText(page.request, channelId);
          text = read.text.trim();
          return read.finished;
        },
        { message: "the routine's run is in its conversation" },
      )
      .toBeGreaterThan(0);
    expect(text.length, "the Bot answered the routine").toBeGreaterThan(0);

    await main
      .getByRole("link", { name: /^Open conversation/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/channel/${channelId}$`));
    const transcript = page
      .getByRole("region", { name: "Messages" })
      .getByRole("log");
    await expect(transcript.getByText(text, { exact: true })).toBeVisible();
    await shot("routine-answer");
  });

  await test.step("back to the routine", async () => {
    await page.getByRole("link", { name: "Routines", exact: true }).click();
    await expect(row).toContainText(
      "Personal Assistant · Wednesdays at 07:30 · Acts",
    );
    await row.click();
    await expect(
      page.getByRole("heading", { name: NAME, level: 1 }),
    ).toBeVisible();
  });

  await test.step("Delete asks first, then removes it", async () => {
    await main
      .getByRole("button", {
        name: "Delete the routine scheduled Wednesdays at 07:30",
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: 'Delete "Wednesdays at 07:30"?',
    });
    await expect(dialog).toBeVisible();
    await shot("delete-asks");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: NAME, level: 1 }),
    ).toBeVisible();

    await main
      .getByRole("button", {
        name: "Delete the routine scheduled Wednesdays at 07:30",
      })
      .click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeHidden();
    // Where Delete leaves the person is the known failure below; the list is what is checked here.
    await page.getByRole("link", { name: "Routines", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Routines", level: 1 }),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(main.getByText("No routines yet")).toBeVisible();
    await shot("routine-deleted");
  });
});

test("Delete takes a person back to the Routines list", async ({
  page,
  shot,
}) => {
  test.fail(
    true,
    "KNOWN BUG: after Delete, the routine's page says \"This routine isn't here\" instead of returning to Routines. The list refetch unmounts the page before the delete's onSuccess runs, and TanStack Query drops a mutate() callback once its component is gone, so the navigation never happens.",
  );
  const main = page.getByRole("main");
  await page.goto("/routines/new");
  await main.getByRole("combobox", { name: "Bot" }).click();
  await page.getByRole("option", { name: "Personal Assistant" }).click();
  await main
    .getByRole("textbox", { name: "What to do" })
    .fill(SECOND_INSTRUCTION);
  await main.getByRole("textbox", { name: "Name" }).fill(SECOND);
  await main.getByRole("button", { name: "Create routine" }).click();
  await main.getByRole("link", { name: new RegExp(`^${SECOND}`) }).click();
  await expect(
    page.getByRole("heading", { name: SECOND, level: 1 }),
  ).toBeVisible();
  await main
    .getByRole("button", { name: /^Delete the routine scheduled / })
    .click();
  const dialog = page.getByRole("dialog", { name: /^Delete "/ });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeHidden();
  await shot("after-delete");
  await expect(main.getByText("This routine isn't here")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Routines", level: 1 }),
  ).toBeVisible({
    timeout: 10_000,
  });
});
