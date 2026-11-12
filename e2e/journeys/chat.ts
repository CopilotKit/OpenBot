import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { SERVER_LOG } from "../harness/stack";
import { expect, type Page } from "../harness/test";

/**
 * What the Bots-and-conversations journeys share: sending a message the way a person does and
 * reading back what the run streamed, from the conversation's own events.
 */

export type ThreadEvent = {
  type: string;
  runId?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
};

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The open conversation's id, from the address bar. */
export function channelIdOf(page: Page): string {
  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(id, "a conversation is open").toMatch(/^channel_[0-9a-f-]+$/);
  return id;
}

/** The transcript of the open conversation. */
export function transcript(page: Page) {
  return page.getByRole("region", { name: "Messages" }).getByRole("log");
}

/** Type a message into the composer on screen and send it. */
export async function send(page: Page, text: string): Promise<void> {
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

/** The conversation's events, once Intelligence has them. */
export async function threadEvents(
  page: Page,
  channelId: string,
): Promise<ThreadEvent[]> {
  const channel = await page.request.get(`/api/channels/${channelId}`);
  expect(channel.ok(), `GET /api/channels/${channelId}`).toBe(true);
  const { threadId } = (
    (await channel.json()) as { channel: { threadId: string } }
  ).channel;
  const response = await page.request.get(
    `/api/copilotkit/threads/${threadId}/events`,
  );
  if (!response.ok()) return [];
  return ((await response.json()) as { events?: ThreadEvent[] }).events ?? [];
}

/** The thread's events cut into runs, each from its RUN_STARTED. */
function runsOf(events: ThreadEvent[]): ThreadEvent[][] {
  const runs: ThreadEvent[][] = [];
  for (const event of events) {
    if (event.type === "RUN_STARTED") runs.push([]);
    runs.at(-1)?.push(event);
  }
  return runs;
}

/**
 * Wait for the Bot to finish answering the message just sent, and answer with what it said.
 *
 * One answer can be several runs: a run that draws something in the conversation (a chart, a card)
 * ends on that tool call, the browser draws it, and the next run carries on from its result. The
 * answer is over when the latest run has finished on words rather than on a tool call, and the Bot
 * can no longer be stopped. `before` is how many runs the conversation had before this message.
 */
export async function answerOf(
  page: Page,
  before = 0,
): Promise<{
  channelId: string;
  answer: string;
  events: ThreadEvent[];
  runs: number;
}> {
  await expect(page).toHaveURL(/\/channel\/channel_[0-9a-f-]+$/);
  const channelId = channelIdOf(page);
  let runs: ThreadEvent[][] = [];
  let seen = -1;
  await expect
    .poll(
      async () => {
        runs = runsOf(await threadEvents(page, channelId));
        const last = runs.at(-1) ?? [];
        // Intelligence stores a run's events as they arrive, so its end can be stored before the
        // last of its words: done is also the same events as the read before.
        const count = runs.flat().length;
        const settled = count === seen;
        seen = count;
        // A tool the server ran has its result in the run; one the browser runs (a chart it
        // draws) has none, and the next run carries on from it.
        const answered = new Set(
          last
            .filter((event) => event.type === "TOOL_CALL_RESULT")
            .map((event) => event.toolCallId),
        );
        return (
          settled &&
          runs.length > before &&
          last.some((event) => event.type === "RUN_FINISHED") &&
          last
            .filter((event) => event.type === "TOOL_CALL_START")
            .every((event) => answered.has(event.toolCallId))
        );
      },
      { message: "the Bot finishes answering", timeout: 120_000 },
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Stop the Bot" })).toBeHidden();
  const events = runs.slice(before).flat();
  const answer = runs
    .at(-1)
    ?.filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta ?? "")
    .join("")
    .trim();
  return { channelId, answer: answer ?? "", events, runs: runs.length };
}

/** The models the server ran a Bot's turns on, from its `run-model` log lines after `mark`. */
export function modelsRunSince(mark: number, agentId: string): string[] {
  const text = readFileSync(SERVER_LOG).subarray(mark).toString("utf8");
  const models: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || !line.includes('"run-model"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        agentId?: string;
        model?: string;
      };
      if (entry.type === "run-model" && entry.agentId === agentId)
        models.push(entry.model ?? "");
    } catch {}
  }
  return models;
}

/** The conversation's row in the sidebar, by the name it shows. */
export function conversationRow(page: Page, name: string | RegExp) {
  return page
    .getByRole("link", {
      name: typeof name === "string" ? new RegExp(escapeRegExp(name)) : name,
    })
    .and(
      page.locator('a[href^="/channel/channel_"], a[href^="/group/channel_"]'),
    );
}

/**
 * Wait for OpenBot to name a conversation, and answer with the name. It names conversations on a
 * 10 s loop with a model call of its own; a journey that started one waits for it, so that call is
 * made (and answered by this journey's fixtures) inside the journey rather than in the next one.
 */
export async function generatedName(
  page: Page,
  channelId: string,
): Promise<string> {
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
  return name;
}

/**
 * Wait until an element has finished fading in: it and every ancestor fully opaque. A web-first
 * visibility check passes at opacity 0, and a screenshot then shows the page through it.
 */
export async function expectSettled(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(
      () =>
        locator.evaluate((element) => {
          let opacity = 1;
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          )
            opacity *= Number(getComputedStyle(node).opacity);
          return opacity;
        }),
      { message: "faded in" },
    )
    .toBe(1);
}

/** Make a Bot through the New Bot sheet, and answer with its id once its profile is open. */
export async function createBot(
  page: Page,
  name: string,
  instructions: string,
): Promise<string> {
  await page.goto("/bots?new=true");
  const sheet = page.getByRole("dialog", { name: "New Bot" });
  await sheet.getByRole("textbox", { name: "Name" }).fill(name);
  await sheet
    .getByRole("textbox", { name: /^Instructions/ })
    .fill(instructions);
  await sheet.getByRole("button", { name: "Create Bot" }).click();
  await expect(page).toHaveURL(/\/bots\/agent_[0-9a-f-]+$/);
  await expect(
    page.getByRole("main").getByRole("heading", { name, level: 1 }),
  ).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

/**
 * Wait until an element has stopped moving: the sidebar animates a conversation to its new place
 * when it is pinned or answered, and a screenshot mid-move shows two rows on top of each other.
 */
export async function expectStill(locator: Locator): Promise<void> {
  let last = "";
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await locator.boundingBox());
        const still = box === last;
        last = box;
        return still;
      },
      { message: "stopped moving", intervals: [100, 100, 200, 200, 300] },
    )
    .toBe(true);
}
