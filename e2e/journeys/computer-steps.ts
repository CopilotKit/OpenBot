import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test as base, expect } from "../harness/test";
import { type Site, startSite } from "../site/site";

/**
 * What the computer and approvals journeys do over and over: make a Bot of their own, talk to it,
 * and read back what a run streamed.
 */

async function createBot(
  request: APIRequestContext,
  name: string,
  roleDescription: string,
): Promise<string> {
  const response = await request.post("/api/agents", {
    data: { name, title: "", roleDescription, visibility: "private" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { agent } = (await response.json()) as { agent: { id: string } };
  return agent.id;
}

/**
 * The harness's `test`, with `makeBot`: A BOT OF ITS OWN FOR EACH JOURNEY, deleted when it ends.
 *
 * A Bot's browser numbers its page snapshots from the first one it takes, and a click a fixture
 * recorded carries that number. On a Bot another journey had already browsed with, the numbers would
 * start further on and the recorded click would be out of date. A new Bot's browser starts at the
 * beginning every time, whichever journeys ran first, and whatever a journey allows (a rule, an
 * answer for a conversation) stays with that Bot. Deleted afterwards, pass or fail, so the journeys
 * after it see the Bots they expect.
 *
 * Made through the API, as setup: making a Bot on screen is the Bots journeys' to test. It runs in
 * OpenBot on the deployment's model, as a Bot made from New Bot does, so aimock answers it.
 */
export const test = base.extend<{
  makeBot: (name: string, roleDescription: string) => Promise<string>;
}>({
  makeBot: async ({ page }, use) => {
    const made: string[] = [];
    await use(async (name, roleDescription) => {
      const id = await createBot(page.request, name, roleDescription);
      made.push(id);
      return id;
    });
    for (const id of made) {
      await page.request.delete(`/api/agents/${encodeURIComponent(id)}`);
    }
  },
});
export { expect };

/** A new conversation with one Bot, from its own address, ready to type in. */
export async function newConversation(page: Page, botId: string) {
  await page.goto(`/channel/new?agent=${encodeURIComponent(botId)}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

/** Send a message and wait for the conversation it lands in. Returns the conversation's id. */
export async function send(page: Page, text: string): Promise<string> {
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/channel\/channel_[0-9a-f-]+/);
  await expect(transcript(page).getByText(text, { exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

/** The conversation's messages, as a person reads them. */
export function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Messages" }).getByRole("log");
}

type ThreadEvent = {
  type: string;
  runId?: string;
  messageId?: string;
  delta?: string;
};

async function threadOf(page: Page, channelId: string): Promise<string> {
  const response = await page.request.get(`/api/channels/${channelId}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { channel: { threadId: string } }).channel
    .threadId;
}

/** Every event of the conversation's runs, from Intelligence through the runtime. */
export async function threadEvents(
  page: Page,
  channelId: string,
): Promise<ThreadEvent[]> {
  const threadId = await threadOf(page, channelId);
  const response = await page.request.get(
    `/api/copilotkit/threads/${threadId}/events`,
  );
  // Intelligence may not have the thread's events yet just after a run.
  if (!response.ok()) return [];
  return ((await response.json()) as { events?: ThreadEvent[] }).events ?? [];
}

/** One run of the conversation: whether it has finished, and the text it streamed. */
type Run = { finished: boolean; text: string };

function runsOf(events: ThreadEvent[]): Run[] {
  const runs: { finished: boolean; text: string[] }[] = [];
  for (const event of events) {
    if (event.type === "RUN_STARTED") runs.push({ finished: false, text: [] });
    const run = runs.at(-1);
    if (!run) continue;
    if (event.type === "TEXT_MESSAGE_CONTENT") run.text.push(event.delta ?? "");
    if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
      run.finished = true;
  }
  return runs.map((run) => ({
    finished: run.finished,
    text: run.text.join("").trim(),
  }));
}

/** How many runs the conversation has had so far: a mark to wait for the next reply from. */
export async function runsSoFar(
  page: Page,
  channelId: string,
): Promise<number> {
  return runsOf(await threadEvents(page, channelId)).length;
}

/**
 * The Bot's reply, once its turn is over: the text the last run that said anything streamed,
 * joined from its `TEXT_MESSAGE_CONTENT` deltas.
 *
 * Over means a run started after `since` (a mark from `runsSoFar`), the last run has finished, and
 * its reply says `until`. A turn is several runs when the Bot uses its computer, one for each step
 * it takes, and between two of them the last run has finished with a sentence like "I'm opening the
 * page": `until` is what tells the answer from that. After an approval the server continues the
 * conversation with runs of its own.
 */
export async function replyAfter(
  page: Page,
  channelId: string,
  since: number,
  until: RegExp,
): Promise<string> {
  let reply = "";
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const runs = runsOf(await threadEvents(page, channelId));
        if (runs.length <= since || !runs.at(-1)?.finished) return false;
        reply =
          runs
            .slice(since)
            .map((run) => run.text)
            .filter(Boolean)
            .at(-1) ?? "";
        /*
         * The same reply on two reads in a row. Read the moment its run has finished, the stored
         * events have been seen to lack a piece of it for a moment ("…order is conf**FH-2044**.",
         * the screen whole), so one read is not yet what was streamed.
         */
        const settled = reply === previous;
        previous = reply;
        return settled && until.test(reply);
      },
      { message: "the Bot's turn ends with a reply", timeout: 180_000 },
    )
    .toBe(true);
  return reply;
}

/**
 * What a reply streamed in Markdown reads as on screen: the words, without the marks that style them.
 * `**FH-2041**` is drawn as FH-2041 in bold, a `[link](https://…)` as its words.
 */
export function asRendered(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=$|[^\w*])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The reply on screen is exactly what was streamed, whole and once: not cut short, not doubled,
 * not two answers run together. `exact` text, so a garbled or interleaved reply fails. Compared as
 * it renders (`asRendered`), since the transcript draws the Markdown the Bot wrote.
 */
export async function expectWholeReply(page: Page, reply: string) {
  const shown = transcript(page).getByText(asRendered(reply), { exact: true });
  await expect(shown).toHaveCount(1);
  await expect(shown).toBeVisible();
}

/** The Bot's turn is over: it can no longer be stopped. */
export async function turnOver(page: Page) {
  await expect(page.getByRole("button", { name: "Stop the Bot" })).toBeHidden({
    timeout: 120_000,
  });
}

/** The Computer, open beside the conversation. */
export function computerPanel(page: Page): Locator {
  return page.getByRole("region", { name: "Computer sidebar" });
}

/**
 * Open the Computer beside the conversation, unless it is open already. Its button in the header
 * says which (`aria-expanded`): the Computer opens itself when the Bot starts browsing, and an
 * address with `watch` opens on it.
 */
export async function openComputer(page: Page): Promise<Locator> {
  const toggle = page.getByRole("button", { name: /^(Open|Close) Computer$/ });
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  const panel = computerPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The rows of Activity, under the Computer's screen, newest first: one per step the Bot took on its
 * computer. The list is the only one in the Computer.
 */
export function activityRows(page: Page): Locator {
  return computerPanel(page).getByRole("list").getByRole("listitem");
}

/**
 * A row on a settings page (an `Item`), found by what it says. Rows have no role of their own, so
 * the row is the item that holds the text, and its buttons are found by role inside it.
 */
export function settingsRow(page: Page, text: string): Locator {
  return page.locator('[data-slot="item"]').filter({ hasText: text });
}

/**
 * The run's own website (`e2e/site`), served for the journey in this file: started before its
 * test and stopped after it. Returns the site, to read the orders and applications it took.
 */
export function serveSite(): () => Site {
  let site: Site | undefined;
  test.beforeAll(async () => {
    site = await startSite();
  });
  test.afterAll(async () => {
    await site?.stop();
  });
  return () => {
    if (!site) throw new Error("The test site is not running.");
    return site;
  };
}

/** A time as Activity prints one beside a step: "12:57:38 PM", or "12:57:38". */
export const CLOCK = /\d{1,2}:\d{2}:\d{2}/;

/**
 * Every row of Activity has the time its step finished: the steps the Bot took itself, the one a
 * person answered, and the ones the server took after an approval, which once had none. And the
 * times run newest first, as the rows do: the step a person answered once read as later than the
 * steps the server took after it, timed by when its answer reached the page.
 */
export async function expectEveryRowTimed(page: Page) {
  const rows = activityRows(page);
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = rows.nth(index).locator("time");
    await expect(time).toHaveText(CLOCK);
    times.push(Date.parse((await time.getAttribute("datetime")) ?? ""));
  }
  expect(times, "Activity's times run newest first").toEqual(
    [...times].sort((a, b) => b - a),
  );
}

/**
 * The Bot's screen fills the frame kept for it: the page is drawn as tall as the frame, with none of
 * the black behind it showing as a band underneath. Read as a person sees it, from where the screen
 * and its frame are laid out, once a frame of the page has been drawn (a canvas starts 300 wide).
 *
 * HELD, NOT SEEN ONCE. A tab left in front after another closed came back short about a second
 * later, so a screen that fills its frame at the first look has to go on filling it: it passes once
 * it has read as filled every time for two seconds.
 */
export async function expectScreenFillsFrame(screen: Locator) {
  const HELD_MS = 2_000;
  let filledSince: number | null = null;
  await expect
    .poll(
      async () => {
        const gap = await screen.evaluate((canvas: HTMLCanvasElement) => {
          const frame = canvas.parentElement?.getBoundingClientRect();
          const drawn = canvas.getBoundingClientRect();
          if (!frame || canvas.width === 300) return "no frame drawn yet";
          return Math.round(frame.bottom - drawn.bottom);
        });
        if (gap !== 0) {
          filledSince = null;
          return gap;
        }
        filledSince ??= Date.now();
        return Date.now() - filledSince >= HELD_MS ? 0 : "filled, not yet held";
      },
      {
        message: "the Bot's screen fills its frame, with no band under it",
        intervals: [250],
        timeout: 15_000,
      },
    )
    .toBe(0);
}

/**
 * The conversation has its generated name. OpenBot names a conversation on a loop after its first
 * answer; waited for here so the naming call is made inside the journey that caused it, and a
 * recording files its fixture with that journey rather than the next one.
 */
export async function named(page: Page, channelId: string) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/channels");
        const { channels } = (await response.json()) as {
          channels: { id: string; summary?: string | null }[];
        };
        return channels.find((channel) => channel.id === channelId)?.summary;
      },
      { message: "OpenBot names the conversation", timeout: 60_000 },
    )
    .toBeTruthy();
}
