import { DUMMY_OPENAI_KEY } from "../harness/config";
import {
  runsInConversation,
  runsLoggedSince,
  serverLogMark,
} from "../harness/runs";
import { expect, test } from "../harness/test";
import { expectSitsNaturally } from "./chat";

/**
 * THE CORE LOOP, as a new person meets it on a fresh stack: first-run setup, an AI key, a first
 * question to the Personal Assistant, one whole answer from one run, and the conversation named.
 *
 * The AI connection is chosen the way the web app offers it: Settings → Setup says the AI model
 * needs a key and links to the Vault's Add key form, where the person pastes an OpenAI key and
 * nothing else. The form starts on the provider the Personal Assistant runs on and asks for no name,
 * so the key lands where the Personal Assistant reads it. (Choosing a provider in a setup window is
 * OpenBot Desktop's, driven in a later slice.) The key is a dummy: aimock answers.
 */

const PERSON = "Sam Rivera";
const QUESTION =
  "In two short plain sentences with no formatting, how often should I water basil growing in a pot on a sunny balcony?";

type ThreadEvent = { type: string; runId?: string; delta?: string };

test("a new person sets up OpenBot and gets a first answer from the Personal Assistant", async ({
  page,
  shot,
  aimock,
}) => {
  await test.step("first-run setup", async () => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Welcome to OpenBot", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Step 1 of 3" }),
    ).toBeVisible();
    await shot("welcome");
    await page.getByRole("button", { name: "Continue" }).click();

    // Each step cross-fades into the next: the screenshot waits for the last one to be gone.
    await expect(
      page.getByRole("heading", { name: "OpenBot for Business", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to OpenBot" }),
    ).toHaveCount(0);
    await shot("openbot-for-business");
    await page.getByRole("button", { name: "Not now" }).click();

    await expect(
      page.getByRole("heading", { name: "What should we call you?", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "OpenBot for Business" }),
    ).toHaveCount(0);
    const getStarted = page.getByRole("button", { name: "Get started" });
    await expect(getStarted).toBeDisabled();
    await page.getByRole("textbox", { name: "Name" }).fill(PERSON);
    await expect(getStarted).toBeEnabled();
    await shot("name");
    await getStarted.click();

    await expect(
      page.getByRole("heading", {
        name: `Hi ${PERSON}, what would you like to work on?`,
      }),
    ).toBeVisible();
    await expect(page.getByText("No conversations yet")).toBeVisible();
    await shot("home");
  });

  await test.step("choose the AI connection: an OpenAI key in the Vault", async () => {
    await page.getByRole("button", { name: PERSON }).click();
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await page.getByRole("link", { name: /^Setup/ }).click();

    const aiModel = page
      .getByRole("list", { name: "Setup" })
      .getByRole("listitem")
      .filter({ hasText: "AI model" });
    await expect(aiModel).toContainText("Needs setup");
    await expect(aiModel).toContainText(
      "Without a model key, OpenBot can't answer.",
    );
    await shot("setup-needs-a-key");

    // Straight to the Vault's Add key form, already on the provider the Personal Assistant runs on.
    await aiModel.getByRole("link", { name: "Vault" }).click();
    await expect(
      page.getByRole("heading", { name: "Add key", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Type" })).toContainText(
      "Model",
    );
    await expect(
      page.getByRole("combobox", { name: "Provider" }),
    ).toContainText("OpenAI");
    await expect(
      page.getByText("Your Bots run on OpenAI and will use this key."),
    ).toBeVisible();
    // Nothing to name, so nothing to get wrong: only the key itself.
    await expect(page.getByRole("textbox", { name: "Key ID" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Secret" }).fill(DUMMY_OPENAI_KEY);
    await shot("add-key");
    await page.getByRole("button", { name: "Save credential" }).click();

    // Filed under the name the Personal Assistant reads (examples/personal/model.yaml).
    await expect(
      page.getByRole("heading", { name: "Vault", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("model · openai-api-key · active"),
    ).toBeVisible();
    await shot("vault-with-key");

    await page.getByRole("link", { name: /^Setup/ }).click();
    await expect(aiModel).toContainText(
      "The key is set but hasn't been checked.",
    );
    await page.getByRole("button", { name: "Check again" }).click();
    // Behind a custom endpoint (aimock), the provider's own check can't vouch for the key, and the
    // row says so rather than claiming it works.
    await expect(aiModel).toContainText(
      "The key is set. OpenBot can't check a custom endpoint.",
    );
    await expect(aiModel).not.toContainText("Needs setup");
    await expect(
      page.getByRole("button", { name: "Check again" }),
    ).toBeEnabled();
    await shot("setup-key-set");
  });

  const mark = serverLogMark();
  let channelId = "";
  let answer = "";

  await test.step("ask the Personal Assistant", async () => {
    await page.getByRole("link", { name: "Back to app" }).click();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(QUESTION);
    await shot("question");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page).toHaveURL(/\/channel\/channel_[0-9a-f-]+$/);
    channelId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const transcript = page
      .getByRole("region", { name: "Messages" })
      .getByRole("log");
    await expect(transcript.getByText(QUESTION, { exact: true })).toBeVisible();
    // The run is over when the Bot can no longer be stopped.
    await expect(
      page.getByRole("button", { name: "Stop the Bot" }),
    ).toBeHidden();
  });

  await test.step("the answer renders whole, from one run", async () => {
    const channel = await page.request.get(`/api/channels/${channelId}`);
    const { threadId } = (
      (await channel.json()) as { channel: { threadId: string } }
    ).channel;

    // What the run streamed, from the conversation's own events.
    let events: ThreadEvent[] = [];
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `/api/copilotkit/threads/${threadId}/events`,
          );
          // Intelligence may not have the thread's events yet just after the run.
          if (!response.ok()) return `HTTP ${response.status()}`;
          events =
            ((await response.json()) as { events?: ThreadEvent[] }).events ??
            [];
          return events.filter((event) => event.type === "RUN_FINISHED").length;
        },
        { message: "the run finishes" },
      )
      .toBe(1);
    answer = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta ?? "")
      .join("")
      .trim();
    expect(
      answer.length,
      "the Personal Assistant answered with text",
    ).toBeGreaterThan(0);

    // Every word of it on screen, once.
    const transcript = page
      .getByRole("region", { name: "Messages" })
      .getByRole("log");
    await expect(transcript.getByText(answer, { exact: true })).toHaveCount(1);
    await expect(transcript.getByText(answer, { exact: true })).toBeVisible();
    // The Personal Assistant's introduction and the first exchange fit, and are shown whole.
    await expect(
      transcript.getByRole("heading", { name: "Personal Assistant", level: 1 }),
    ).toBeInViewport({ ratio: 1 });
    await expectSitsNaturally(page);
    await shot("answer");

    // One message, one run: in the conversation's events and in the server's log.
    expect(await runsInConversation(page.request, channelId)).toHaveLength(1);
    expect(runsLoggedSince(mark, "personal-assistant")).toHaveLength(1);
    // And one call to the model for it.
    const responses = (await aimock.requests()).filter(
      (entry) =>
        entry.method === "POST" && entry.path.startsWith("/v1/responses"),
    );
    expect(responses).toHaveLength(1);
  });

  await test.step("the conversation gets its generated name", async () => {
    let name = "";
    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/channels");
          const { channels } = (await response.json()) as {
            channels: { id: string; summary?: string | null }[];
          };
          name =
            channels.find((channel) => channel.id === channelId)?.summary ?? "";
          return name;
        },
        { message: "OpenBot names the conversation", timeout: 60_000 },
      )
      .not.toBe("");
    // A name of its own, not the question or the answer standing in for one.
    expect(name).not.toContain(QUESTION.slice(0, 30));
    expect(name).not.toBe(answer);
    const conversation = page.getByRole("link", {
      name: new RegExp(escapeRegExp(name)),
    });
    await expect(conversation).toBeVisible();
    await expect(conversation).toHaveAttribute("href", `/channel/${channelId}`);
    await expectSitsNaturally(page);
    await shot("named");
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
