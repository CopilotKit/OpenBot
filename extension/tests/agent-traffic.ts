// Recorded real AG-UI traffic (tests/fixtures/agent-traffic, recorded by scripts/agent-traffic/record.ts from a real
// CopilotKit runtime and real OpenAI agents) turned into what the network capture hands the agent events: a run's
// request (unwrapped from CopilotKit's single-route envelope), each AG-UI event of its SSE response or of its
// Intelligence WebSocket channel, and each stream's end, at the times they arrived. Beside it, what CopilotKit itself
// emitted for the same traffic through its legacy sink.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import {
  type AgentEvents,
  createAgentEvents,
} from "../src/background/agent/events";
import type { AgentObservation } from "../src/background/agent/observation";

const ROOT = join(import.meta.dir, "fixtures/agent-traffic");
/** Recorded times are offsets from the start of each conversation; observations carry real epoch times. */
export const CLOCK = 1_792_000_000_000;

type Exchange = {
  at: number;
  url: string;
  body: string | null;
  status: number;
  contentType: string | null;
  chunks: { at: number; text: string }[];
  end: { at: number; outcome: "complete" | "failed" } | null;
};
type Frame = {
  at: number;
  socket: number;
  direction: "in" | "out";
  joinRef: string | null;
  topic: string;
  event: string;
  payload?: unknown;
};
type SinkBatch = { events: CapturedEvent[] };
export type Fixture = {
  name: string;
  transport: "sse" | "intelligence";
  exchanges: Exchange[];
  frames: Frame[];
  sink: SinkBatch[];
  replaySink?: SinkBatch[];
  replayFromAt?: number;
};

export const fixtureNames = (transport: Fixture["transport"]): string[] =>
  readdirSync(join(ROOT, transport))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();

export const loadFixture = (
  transport: Fixture["transport"],
  name: string,
): Fixture =>
  JSON.parse(readFileSync(join(ROOT, transport, `${name}.json`), "utf8"));

/** The AG-UI events of an SSE body: each `data:` field of each block, as JSON. */
export function sseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(JSON.parse(data));
  }
  return events;
}

const envelope = (body: string | null) => {
  const parsed = JSON.parse(body ?? "{}") as {
    method?: string;
    params?: { agentId?: string };
    body?: unknown;
  };
  return parsed;
};

/**
 * The observations the network capture makes of a fixture's traffic, in arrival order. `between` keeps only traffic that
 * started in [from, until): a recording that began, or ended, part-way through.
 */
export function observationsOf(
  fixture: Fixture,
  between: { from?: number; until?: number } = {},
  tabId = 1,
): AgentObservation[] {
  const { from = 0, until = Number.POSITIVE_INFINITY } = between;
  const within = (at: number) => at >= from && at < until;
  const out: AgentObservation[] = [];
  const agents = new Map<string, string | null>();
  fixture.exchanges.forEach((exchange, index) => {
    if (!within(exchange.at)) return;
    const { method, params, body } = envelope(exchange.body);
    const agentId = params?.agentId ?? null;
    const streamId = `http-${index}`;
    const input = body as { threadId?: string };
    if (input?.threadId) agents.set(input.threadId, agentId);
    out.push({
      kind: "request",
      tabId,
      streamId,
      at: CLOCK + exchange.at,
      url: exchange.url,
      agentId,
      method: method as "agent/run" | "agent/connect",
      input: body,
    });
    if (exchange.contentType?.includes("text/event-stream")) {
      // A chunk can end inside an event: events are cut at block boundaries across chunks, each at the chunk that
      // completed it.
      let buffer = "";
      for (const chunk of exchange.chunks) {
        buffer += chunk.text;
        const cut = buffer.lastIndexOf("\n\n");
        if (cut === -1) continue;
        for (const event of sseEvents(buffer.slice(0, cut)))
          out.push({
            kind: "event",
            tabId,
            streamId,
            at: CLOCK + chunk.at,
            agentId,
            threadId: input?.threadId ?? null,
            event,
          });
        buffer = buffer.slice(cut + 2);
      }
    }
    if (exchange.end)
      out.push({
        kind: "end",
        tabId,
        streamId,
        at: CLOCK + exchange.end.at,
        outcome: exchange.status >= 400 ? "failed" : exchange.end.outcome,
      });
  });
  const channels = new Map<string, string>();
  for (const frame of fixture.frames) {
    const key = `${frame.socket}:${frame.topic}`;
    if (frame.event === "phx_join" && frame.direction === "out") {
      channels.set(key, `ws-${key}:${frame.joinRef}`);
      continue;
    }
    const streamId = channels.get(key);
    if (!streamId || !within(frame.at)) continue;
    const threadId = frame.topic.replace(/^thread:/, "");
    if (frame.event === "ag_ui_event")
      out.push({
        kind: "event",
        tabId,
        streamId,
        at: CLOCK + frame.at,
        agentId: agents.get(threadId) ?? null,
        threadId,
        event: frame.payload,
      });
    else if (frame.event === "phx_leave" || frame.event === "phx_close") {
      out.push({
        kind: "end",
        tabId,
        streamId,
        at: CLOCK + frame.at,
        outcome: "complete",
      });
      channels.delete(key);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The events CopilotKit emitted, in order, with the collector's own sequence number left out. */
export function sinkEvents(batches: SinkBatch[]): CapturedEvent[] {
  return batches.flatMap((batch) => batch.events);
}

/** The Thread of a conversation's first run, as CopilotKit named it. */
export function firstThreadOf(fixture: Fixture): string {
  const run = sinkEvents(fixture.sink).find(
    (event) => event.name === "agent.run",
  );
  const threadId = (run?.value as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId !== "string") throw new Error(`${fixture.name}: no run`);
  return threadId;
}

/** What only CopilotKit can see: a frontend tool running inside the page (`tool.call` executing and completed). */
export const observable = (event: CapturedEvent): boolean =>
  ["agent.run", "agent.message", "tool.call"].includes(event.name) &&
  !(
    event.name === "tool.call" &&
    ["executing", "completed"].includes(
      String((event.value as { phase?: unknown }).phase),
    )
  );

export const withoutSeq = (event: CapturedEvent) => {
  const { seq: _seq, ...value } = event.value as Record<string, unknown>;
  return { name: event.name, value };
};

/** Lets the library apply everything fed so far: its subscribers run in promise jobs. */
export const settle = async () => {
  for (let round = 0; round < 5; round++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Hands observations to the agent events as the service worker does: each in a task of its own. */
export async function feed(
  agentEvents: AgentEvents,
  observations: AgentObservation[],
): Promise<void> {
  for (const observation of observations) {
    agentEvents.observe(observation);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await settle();
}

/** New agent events, and what they emitted. */
export function agentEventsFor(digests: ReadonlySet<string> = new Set()) {
  const emitted: CapturedEvent[] = [];
  const agentEvents = createAgentEvents({
    emit: (_tabId, event) => emitted.push(event),
    digests: () => digests,
    now: () => CLOCK,
  });
  return { emitted, agentEvents };
}

/** Runs the agent events over observations, and returns what they emitted. */
export async function record(
  observations: AgentObservation[],
  digests?: ReadonlySet<string>,
) {
  const { emitted, agentEvents } = agentEventsFor(digests);
  await feed(agentEvents, observations);
  return { emitted, agentEvents };
}
