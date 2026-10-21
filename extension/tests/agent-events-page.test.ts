// The learning deal page as a person used it in real Chrome: the chat box clicked, a message typed and sent, then the
// human-in-the-loop Approve clicked once the agent asked (tests/fixtures/agui: single-route-sse.json over SSE,
// intelligence-websocket.json through Intelligence). The page's real traffic goes through the real network capture,
// the agent events and the steps, wired as the recording wires them, and each click is the content script's own capture
// of the element the person clicked, at the moment the recording marks. What leaves is held to what CopilotKit's own
// capture recorded for the same page flow (learning-page-copilotkit.json): its agent rows one for one, and the agent
// context of each click. OpenBot's own chat (openbot-chat.json) goes the same way, with OpenBot connected.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { createAgentEvents } from "../src/background/agent/events";
import { createNetworkCapture } from "../src/background/network";
import { createStepAssembler } from "../src/background/steps";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import {
  type FixtureMark,
  loadFixture,
  marks,
  replay,
  requests,
} from "./support/cdp-replay";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

const TAB = 7;
type Row = { name: string; timestamp: number; value: Record<string, unknown> };

const copilotKit = (
  loadFixture("learning-page-copilotkit") as unknown as { events: Row[] }
).events;

beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://127.0.0.1:7620/learning/deals/deal-2",
  }),
);
afterAll(() => GlobalRegistrator.unregister());

let fake: ChromeFake | null = null;
afterEach(() => {
  fake?.uninstall();
  fake = null;
  document.body.innerHTML = "";
});

/** happy-dom cannot make trusted events; a person's click is, so these are marked trusted by hand. */
function press(element: Element, type: string) {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    detail: 1,
  });
  Object.defineProperty(event, "isTrusted", { value: true });
  element.dispatchEvent(event);
}

/** The content script's capture of a click on the element `selector` finds in `html`, at `at`. */
function clickOn(html: string, selector: string, at: number): CapturedEvent {
  const click = stepsOf(html, selector, at).find(
    ({ name }) => name === "click",
  );
  if (!click) throw new Error("the click was not captured");
  return click;
}

/** Every step the content script captured of a click on the element `selector` finds in `html`: the click, and the
 * submit a form's submit button makes of it a moment later. */
function stepsOf(html: string, selector: string, at: number): CapturedEvent[] {
  const sent: CapturedEvent[] = [];
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  const untrack = tracker.install();
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  try {
    document.body.innerHTML = html;
    const element = document.querySelector(selector);
    if (!element) throw new Error(`nothing at ${selector}`);
    press(element, "pointerdown");
    press(element, "click");
    // A form's submit button submits its form as the click's default action, a trusted submit, which happy-dom does
    // not do for a click made by hand.
    const form = element.closest("form");
    if (form && element.getAttribute("type") === "submit") {
      const submit = new Event("submit", { bubbles: true, cancelable: true });
      Object.defineProperty(submit, "isTrusted", { value: true });
      Object.defineProperty(submit, "submitter", { value: element });
      form.dispatchEvent(submit);
    }
  } finally {
    capture.stop();
    untrack();
  }
  return sent
    .filter(({ name }) => name === "click" || name === "submit")
    .map((step) => ({
      ...step,
      timestamp: step.name === "submit" ? at + 1 : at,
    }));
}

const AGENT_ROWS = new Set([
  "thread.linked",
  "agent.run",
  "agent.message",
  "tool.call",
]);

/**
 * Records the page: its traffic through the network capture into the agent events, whose events the steps place by
 * their time; each click enriched as it arrives and settled as it leaves, as recording.ts wires them. Returns what left
 * the steps, in the Trajectory's order. `openbot` is the OpenBot the recording is connected to; `steps` draws what each
 * recorded click landed on and captures the steps it made, in place of the learning page's chat.
 */
async function recordPage(
  name: string,
  page: {
    openbot?: string;
    steps?: (mark: FixtureMark) => CapturedEvent[];
  } = {},
) {
  fake = installChromeFake({ extensionId: "test" });
  const fixture = loadFixture(name);
  const sent: CapturedEvent[] = [];
  let now = () => 0;
  let agentEvents: ReturnType<typeof createAgentEvents> | null = null;
  const steps = createStepAssembler({
    emit: (event) => sent.push(event),
    now: () => now(),
    settle: (tabId, event, owns) =>
      event.name === "click" && agentEvents
        ? agentEvents.settleClick(tabId, event, owns)
        : event,
  });
  const emitted: CapturedEvent[] = [];
  agentEvents = createAgentEvents({
    emit: (tabId, event) => {
      emitted.push(event);
      steps.place(tabId, event);
    },
    digests: () => new Set(),
    now: () => now(),
  });
  const capture = createNetworkCapture(
    {
      openbotUrl: () => page.openbot ?? null,
      call: (call) => steps.call(call),
      writeStarted: (id, tabId, startedAt) =>
        steps.writeStarted(id, tabId, startedAt),
      writeEnded: (id) => steps.writeEnded(id),
      status: () => {},
      digests: () => new Set(),
      agent: (observation) => agentEvents?.observe(observation),
    },
    {
      fallback: {
        start: async () => false,
        addTab: async () => {},
        onCommitted: async () => {},
        stop: async () => {},
        active: () => false,
      },
    },
  );
  await capture.start(TAB, String(marks(fixture, "navigate")[0]?.data?.url));
  /** The element each recorded click landed on, as CopilotKit's chat draws it. */
  const clicked = (mark: FixtureMark): [string, string] => {
    if (mark.data?.name === "focus")
      return [
        '<textarea data-testid="copilot-chat-textarea" placeholder="Type a message..."></textarea>',
        "textarea",
      ];
    if (mark.data?.name === "send")
      return [
        '<button type="button" data-testid="copilot-send-button"></button>',
        "button",
      ];
    // The approval card is drawn inside the agent's message, in its tool call's place.
    const call = emitted.find(
      ({ name, value }) =>
        name === "tool.call" &&
        (value as { toolName?: unknown }).toolName === "approveDeal",
    )?.value as { messageId: string; toolCallId: string };
    return [
      `<div data-message-id="${call.messageId}"><div data-tool-call-id="${call.toolCallId}"><p>Approve 48000 for deal-2?</p><button type="button" data-copilotkit-action="hitl.approve">Approve</button></div></div>`,
      "button",
    ];
  };
  const played = replay(fake, TAB, fixture, {
    onMark(mark) {
      if (mark.name !== "click") return;
      const made = page.steps
        ? page.steps(mark)
        : [clickOn(...clicked(mark), mark.wall)];
      for (const step of made)
        steps.step(
          TAB,
          step.name === "click"
            ? (agentEvents?.enrichClick(TAB, step) ?? step)
            : step,
        );
    },
  });
  now = () => played.now();
  await played.run();
  steps.flush();
  await capture.stop();
  return { fixture, sent };
}

/** Rows with their ids named in the order they first appear (`ids` carries the naming on), and without what two
 * sessions of the same flow cannot share: what was written, and how long the person took to answer. */
function shape(rows: Row[], ids = new Map<string, string>()) {
  return rows.map(({ name, value }) => {
    const kept: Record<string, unknown> = {};
    for (const [field, item] of Object.entries(value)) {
      if (["seq", "text", "textLength", "durationMs"].includes(field)) continue;
      if (
        ["threadId", "runId", "messageId", "toolCallId"].includes(field) &&
        typeof item === "string"
      ) {
        if (!ids.has(item)) ids.set(item, `id-${ids.size + 1}`);
        kept[field] = ids.get(item);
      } else kept[field] = item;
    }
    return { name, value: kept };
  });
}

const rowsOf = (events: CapturedEvent[] | Row[]): Row[] =>
  (events as Row[]).filter(({ name }) => AGENT_ROWS.has(name));

/** The agent context CopilotKit's enricher adds to a click. */
const context = ({ value }: Row) =>
  Object.fromEntries(
    Object.entries(value).filter(([field]) =>
      [
        "threadId",
        "agentId",
        "messageId",
        "runId",
        "toolCallId",
        "toolName",
        "toolStatus",
        "threadAmbiguity",
      ].includes(field),
    ),
  );

/** When the page posted each agent run, by the wall clock its requests carry. */
function runRequests(fixture: ReturnType<typeof loadFixture>): number[] {
  const out: number[] = [];
  for (const sent of requests(fixture).values()) {
    const request = sent.request as { method: string; postData?: string };
    const body = request.postData ?? "";
    if (request.method === "POST" && body.includes('"method":"agent/run"'))
      out.push(Math.round((sent.wallTime as number) * 1000));
  }
  return out;
}

for (const name of ["single-route-sse", "intelligence-websocket"])
  test(`the agent's side of the page is CopilotKit's own, row for row: ${name}`, async () => {
    const { fixture, sent } = await recordPage(name);
    const ours = rowsOf(sent);
    const theirs = rowsOf(copilotKit);
    expect(ours.length).toBe(13);
    // thread.linked in CopilotKit's legacy shape before the Thread's first message; the human-in-the-loop tool executing
    // as its run finishes and completed when the person's answer goes out, from where the agent called it.
    expect(shape(ours)).toEqual(shape(theirs));

    const at = (row: Row | undefined) => row?.timestamp;
    const phase = (row: Row, value: string) =>
      row.name === "tool.call" && row.value.phase === value;
    const executing = ours.find((row) => phase(row, "executing"));
    const completed = ours.find((row) => phase(row, "completed"));
    const firstRunEnd = ours.find(
      (row) => row.name === "agent.run" && row.value.phase === "finished",
    );
    // Executing leaves with its run's RUN_FINISHED, right after the run's end.
    expect(at(executing)).toBe(at(firstRunEnd));
    expect(ours.indexOf(executing as Row)).toBe(
      ours.indexOf(firstRunEnd as Row) + 1,
    );
    // Completed when the page sends the answer (the follow-up run's request), before that run's events.
    const [, followUp] = runRequests(fixture);
    expect(at(completed)).toBe(followUp);
    expect(completed?.value.durationMs).toBe(
      (followUp as number) - (at(executing) as number),
    );
    expect(completed?.value.outcome).toBe("ok");
    const approve = sent.findIndex(
      ({ name, value }) =>
        name === "click" &&
        (value as { toolStatus?: unknown }).toolStatus !== undefined,
    );
    const followUpStarted = sent.findLastIndex(
      ({ name, value }) =>
        name === "agent.run" &&
        (value as { phase?: unknown }).phase === "started",
    );
    expect(sent.indexOf(completed as CapturedEvent)).toBeGreaterThan(approve);
    expect(sent.indexOf(completed as CapturedEvent)).toBe(followUpStarted - 1);
  });

for (const name of ["single-route-sse", "intelligence-websocket"])
  test(`each click carries the agent context CopilotKit's own capture gave it, as far as the traffic shows it: ${name}`, async () => {
    const { sent } = await recordPage(name);
    const ids = new Map<string, string>();
    shape(rowsOf(sent), ids);
    const theirIds = new Map<string, string>();
    shape(rowsOf(copilotKit), theirIds);
    const ours = shape(
      (sent as Row[])
        .filter(({ name }) => name === "click")
        .map((row) => ({ ...row, value: context(row) })),
      ids,
    );
    const theirs = shape(
      copilotKit
        .filter(({ name }) => name === "click")
        .map((row) => ({ ...row, value: context(row) })),
      theirIds,
    );
    expect(ours).toHaveLength(3);
    // The chat box, clicked before the page has said anything to its agent: the page runs CopilotKit (its runtime
    // answered the `info` call), so the click carries CopilotKit's open-Thread context, but the network has not shown
    // the Thread yet. CopilotKit, which sees the chat, names it.
    expect(ours[0]).toEqual({ name: "click", value: { threadId: null } });
    expect(theirs[0]?.value).toEqual({ threadId: "id-1" });
    // Send names the Thread of the run it started; Approve names the tool call it answers, still executing.
    expect(ours.slice(1)).toEqual(theirs.slice(1));
    expect(ours[2]?.value.toolStatus).toBe("executing");
  });

for (const name of ["single-route-sse", "intelligence-websocket"])
  test(`a run's history carries only what no event carried, and nothing of Intelligence's bookkeeping: ${name}`, async () => {
    const { sent } = await recordPage(name);
    // Intelligence's ids ride in the metadata of the reasoning message the page holds from it: never in what leaves.
    expect(JSON.stringify(sent)).not.toContain("cpki_");
    const started = sent.filter(
      ({ name, value }) =>
        name === "agent.event" &&
        (value as { event: { type: string } }).event.type === "RUN_STARTED",
    );
    expect(started).toHaveLength(2);
    const followUp = started[1] as CapturedEvent;
    const history = (
      followUp.value as {
        event: { input: { messages?: { role: string }[] } };
      }
    ).event.input.messages;
    // The follow-up run's history: the person's answer is new; the reasoning message an agent.message carried is not
    // carried again.
    expect(history?.map(({ role }) => role)).toEqual(["tool"]);
  });

test("OpenBot's own chat: the composer, clicked before any Thread, names none, and Send names the Thread of the run it started", async () => {
  // End-to-end run 3: neither click carried a threadId at all. The capture ignored OpenBot's runtime `info` call with
  // the rest of OpenBot's own calls, so it never knew the page runs CopilotKit; and Send is the submit button of the
  // composer's form, whose submit, a millisecond after the click, closed the click's span before the run it started.
  // The clicks land on the composer as run 3 recorded it: its Message editor, then Send.
  const fixture = loadFixture("openbot-chat");
  const openbot = new URL(String(marks(fixture, "navigate")[0]?.data?.url))
    .origin;
  const { sent } = await recordPage("openbot-chat", {
    openbot,
    steps: (mark) =>
      mark.data?.name === "focus"
        ? stepsOf(
            '<div role="textbox" aria-label="Message" aria-multiline="true" contenteditable="true"></div>',
            '[aria-label="Message"]',
            mark.wall,
          )
        : stepsOf(
            '<form><div role="textbox" aria-label="Message" contenteditable="true">Hi! In one short sentence, what is 2 plus 2?</div><button type="submit" aria-label="Send message" data-slot="button"></button></form>',
            'button[aria-label="Send message"]',
            mark.wall,
          ),
  });
  // The Thread of the run Send started, from the run's body (past 64 KiB, so read with getRequestPostData).
  const [runRequest] = [...requests(fixture)].find(([, request]) =>
    String((request.request as { url: string }).url).endsWith(
      "/api/copilotkit/agent/general-assistant/run",
    ),
  ) ?? [""];
  const body = fixture.entries.find(
    (entry) =>
      entry.kind === "command" &&
      entry.method === "Network.getRequestPostData" &&
      entry.params.requestId === runRequest,
  );
  const thread = (
    JSON.parse(
      String(body?.kind === "command" ? body.result?.postData : "{}"),
    ) as { threadId?: string }
  ).threadId;
  expect(thread).toBeString();
  expect(sent.filter(({ name }) => name === "submit")).toHaveLength(1);
  const clicks = (sent as Row[])
    .filter(({ name }) => name === "click")
    .map(
      (row): Record<string, unknown> => ({
        label: (row.value.target as { label?: string }).label,
        ...context(row),
      }),
    );
  expect(clicks).toEqual([
    { label: "Message", threadId: null },
    { label: "Send message", threadId: thread },
  ]);
});
