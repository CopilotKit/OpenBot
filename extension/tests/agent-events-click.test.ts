// A click gets CopilotKit's agent context: the content script reads the chat message and tool call around the click as
// CopilotKit's enricher does, the agent events resolve them against the agent's own messages, and the click that leaves
// carries exactly what CopilotKit's own click capture added for the same click on the same page, recorded from real
// CopilotKit (fixtures/agent-traffic/sse/clicks.json): the exact message (with its tool call) first, else the open Thread,
// else the open Threads' ambiguity.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { startEventCapture } from "../src/content/collector";
import { createSensitivityTracker } from "../src/content/masking-context";
import { AGENT_TARGET_FIELD } from "../src/shared/agent-target";
import {
  agentEventsFor,
  CLOCK,
  feed,
  firstThreadOf,
  loadFixture,
  observationsOf,
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
