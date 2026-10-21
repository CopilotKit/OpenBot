// A click gets CopilotKit's agent context: the content script reads the chat message and tool call around the click as
// CopilotKit's enricher does, the agent events resolve them against the agent's own messages, and the click that leaves
// carries exactly what CopilotKit's own click capture added for the same click on the same page, recorded from real
// CopilotKit (fixtures/agent-traffic/sse/clicks.json): the exact message (with its tool call) first, else the open Thread,
// else the open Threads' ambiguity.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  type AgentEvents,
  createAgentEvents,
} from "../src/background/agent/events";
import type { AgentObservation } from "../src/background/agent/observation";
import { createStepAssembler } from "../src/background/steps";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import { AGENT_TARGET_FIELD } from "../src/shared/agent-target";
import {
  agentEventsFor,
  CLOCK,
  feed,
  firstThreadOf,
  loadFixture,
  movedTo,
  newThreadRuns,
  observationsOf,
  settle,
  sinkEvents,
} from "./agent-traffic";

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" }));
afterAll(() => GlobalRegistrator.unregister());

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = "";
});

/** The fields CopilotKit's enricher adds to a click. */
const AGENT_CONTEXT = [
  "threadId",
  "agentId",
  "messageId",
  "runId",
  "toolCallId",
  "toolName",
  "toolStatus",
  "threadAmbiguity",
];
const agentContext = (event: CapturedEvent) =>
  Object.fromEntries(
    Object.entries(event.value as Record<string, unknown>).filter(([key]) =>
      AGENT_CONTEXT.includes(key),
    ),
  );

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

/** The page's clicks, as the content script captures them. */
function clicksOn(html: string, selectors: string[]): CapturedEvent[] {
  const sent: CapturedEvent[] = [];
  const tracker = createSensitivityTracker({ isTrusted: () => true });
  stops.push(tracker.install());
  const capture = startEventCapture({
    tracker,
    send: (event) => sent.push(event),
  });
  stops.push(capture.stop);
  document.body.innerHTML = html;
  for (const selector of selectors) {
    const element = document.querySelector(selector) as Element;
    press(element, "pointerdown");
    press(element, "click");
  }
  return sent.filter((event) => event.name === "click");
}

test("each click carries exactly the agent context CopilotKit's own click capture gave it, with one chat open and with two", async () => {
  const fixture = loadFixture("sse", "clicks") as ReturnType<
    typeof loadFixture
  > & {
    clicks: { at: number; html: string; selectors: string[] }[];
  };
  const copilotKitClicks = sinkEvents(fixture.sink).filter(
    (event) => event.name === "click",
  );
  const observations = observationsOf(fixture);
  const { agentEvents } = agentEventsFor();
  let fed = 0;
  let compared = 0;
  for (const { at, html, selectors } of fixture.clicks) {
    const upTo = observations.filter(
      (observation) => observation.at <= CLOCK + at,
    );
    await feed(agentEvents, upTo.slice(fed));
    fed = upTo.length;
    const clicks = clicksOn(html, selectors);
    expect(clicks).toHaveLength(selectors.length);
    for (const click of clicks) {
      const expected = copilotKitClicks[compared++] as CapturedEvent;
      const enriched = agentEvents.enrichClick(1, click);
      expect(agentContext(enriched)).toEqual(agentContext(expected));
      expect(enriched.value).not.toHaveProperty(AGENT_TARGET_FIELD);
    }
  }
  expect(compared).toBe(copilotKitClicks.length);
  expect(compared).toBe(12);
});

test("a click in a tab that has seen no AG-UI carries no Thread fields, and never the private target", async () => {
  const fixture = loadFixture("sse", "clicks") as ReturnType<
    typeof loadFixture
  > & {
    clicks: { html: string; selectors: string[] }[];
  };
  const { agentEvents } = agentEventsFor();
  await feed(agentEvents, observationsOf(fixture));
  const [first] = fixture.clicks;
  const clicks = clicksOn(first?.html ?? "", first?.selectors ?? []);
  expect(clicks[0]?.value).toHaveProperty(AGENT_TARGET_FIELD);
  for (const click of clicks) {
    const elsewhere = agentEvents.enrichClick(2, click);
    expect(agentContext(elsewhere)).toEqual({});
    expect(elsewhere.value).not.toHaveProperty(AGENT_TARGET_FIELD);
  }
});

test("a Thread closes when its tab reaches another page: the next click there names no open Thread", async () => {
  const fixture = loadFixture("sse", "two-runs");
  const { agentEvents } = agentEventsFor();
  await feed(agentEvents, observationsOf(fixture));
  const click: CapturedEvent = {
    type: "CUSTOM",
    name: "click",
    timestamp: CLOCK,
    value: { target: { tag: "button" } },
  };
  const threadId = firstThreadOf(fixture);
  expect(agentContext(agentEvents.enrichClick(1, click))).toEqual({ threadId });
  agentEvents.tabNavigated(1);
  expect(agentContext(agentEvents.enrichClick(1, click))).toEqual({
    threadId: null,
  });
});

/** The steps and the agent events wired as recording.ts wires them, on a clock the test moves: each timer fires as the
 * clock passes it, as a real one does, so a click leaves when its steps let it go, knowing what the page did by then. */
function recordingOn(start: number) {
  let clock = start;
  const due: { at: number; fn: () => void; live: boolean }[] = [];
  const sent: CapturedEvent[] = [];
  let agentEvents: AgentEvents | null = null;
  const steps = createStepAssembler({
    emit: (event) => sent.push(event),
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const timer = { at: clock + ms, fn, live: true };
        due.push(timer);
        return timer;
      },
      clear: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    },
    settle: (tabId, event, joins) =>
      event.name === "click" && agentEvents
        ? agentEvents.settleClick(tabId, event, joins)
        : event,
    awaits: (tabId, event, joins) =>
      event.name === "click" &&
      agentEvents !== null &&
      agentEvents.awaitsRun(tabId, event, joins),
  });
  const events = createAgentEvents({
    emit: (tabId, event) => steps.place(tabId, event),
    digests: () => new Set(),
    now: () => clock,
  });
  agentEvents = events;
  return {
    steps,
    sent,
    agentEvents: events,
    /** Moves the clock to `to`, firing every timer due on the way. */
    advance(to: number) {
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due.find((timer) => timer.live && timer.at <= to);
        if (!next) break;
        next.live = false;
        clock = Math.max(clock, next.at);
        next.fn();
      }
      clock = Math.max(clock, to);
    },
  };
}

for (const run of newThreadRuns())
  test(`after New thread, the click that sends the next message names the new Thread, and one before that run names none, never the Thread left: end-to-end ${run.name}`, async () => {
    // End-to-end runs 1 and 2 (rows 034 and 036): after New thread the chat box and Send both named the Thread the chat
    // had left, where CopilotKit's own capture named the new one. New thread calls nothing, so the traffic shows the new
    // Thread only with the run Send starts.
    const copilotKit = run.copilotKit;
    const value = (row: CapturedEvent) => row.value as Record<string, unknown>;
    const [opened] = copilotKit.filter(({ name }) => name === "thread.linked");
    const theirFirst = opened ? value(opened).threadId : undefined;
    const answered = copilotKit.findLast(
      (row) =>
        row.name === "agent.run" &&
        value(row).phase === "finished" &&
        value(row).threadId === theirFirst,
    )?.timestamp as number;
    const theirClicks = copilotKit.filter(
      (row) => row.name === "click" && row.timestamp > answered,
    );
    expect(
      theirClicks.map(
        (row) => (value(row).target as { label: string | null }).label,
      ),
    ).toEqual([
      null,
      "Approve without the agent",
      "New thread",
      null,
      "Send message",
    ]);

    // The same page on real traffic: one agent's answer on one Thread, then the person's clicks at run's times after
    // it, and the run on a new Thread of the agent when the page asked for it in the run.
    const first = loadFixture("sse", "text-answer");
    const second = loadFixture("sse", "backend-tool");
    const shift =
      Math.max(...observationsOf(first).map(({ at }) => at)) - answered;
    const observations = movedTo(first, second, run.secondRunRequestAt + shift);
    const elements: [string, string][] = [
      ["<h1>Acme renewal</h1>", "h1"],
      [
        '<button type="button" data-copilotkit-action="deal.approve">Approve without the agent</button>',
        "button",
      ],
      [
        '<button type="button" data-copilotkit-action="thread.new">New thread</button>',
        "button",
      ],
      [
        '<textarea data-testid="copilot-chat-textarea" placeholder="Type a message..."></textarea>',
        "textarea",
      ],
      [
        '<button type="button" data-testid="copilot-send-button" aria-label="Send message"></button>',
        "button",
      ],
    ];
    type Due =
      | { at: number; observation: AgentObservation }
      | { at: number; click: [string, string] }
      | { at: number; typed: CapturedEvent };
    const timeline: Due[] = [
      ...observations.map((observation) => ({
        at: observation.at,
        observation,
      })),
      ...theirClicks.map((row, index) => ({
        at: row.timestamp + shift,
        click: elements[index] as [string, string],
      })),
      { at: run.typed.timestamp + shift, typed: run.typed },
    ].sort((a, b) => a.at - b.at);

    const recording = recordingOn(CLOCK);
    for (const due of timeline) {
      recording.advance(due.at);
      if ("observation" in due) recording.agentEvents.observe(due.observation);
      else if ("click" in due) {
        const [click] = clicksOn(due.click[0], [due.click[1]]);
        recording.steps.step(
          1,
          recording.agentEvents.enrichClick(1, {
            ...(click as CapturedEvent),
            timestamp: due.at,
          }),
        );
      } else recording.steps.step(1, { ...due.typed, timestamp: due.at });
      await settle();
    }
    recording.advance((timeline.at(-1)?.at ?? CLOCK) + 30_000);
    await settle();

    const ours = recording.sent
      .filter(({ name }) => name === "click")
      .map((row) => value(row).threadId);
    const left = firstThreadOf(first);
    const moved = firstThreadOf(second);
    // Each click before the move, and Send, as CopilotKit gave them; the chat box in between, which no traffic places in
    // either Thread, names none.
    const ourIds = new Map([
      [theirFirst, left],
      [
        value(
          copilotKit.filter(
            ({ name }) => name === "thread.linked",
          )[1] as CapturedEvent,
        ).threadId,
        moved,
      ],
    ]);
    const theirs = theirClicks.map((row) => ourIds.get(value(row).threadId));
    expect(theirs).toEqual([left, left, left, moved, moved]);
    expect(ours).toEqual([left, left, left, null, moved]);
  });
