// The heart of the agent events: for real traffic from a real CopilotKit runtime and real OpenAI agents, recorded with
// what CopilotKit itself emitted for it (scripts/agent-traffic/record.ts), the Recorder emits CopilotKit's own
// `thread.linked`, `agent.run`, `agent.message` and `tool.call` events, field for field and in the same order, over SSE
// and over the Intelligence WebSocket alike, a frontend tool's executing and completed among them. How long a frontend
// tool ran is the one thing the page times and the network cannot: it is the gap from its run's end to the request that
// carries its result, held on its own. CopilotKit's events are compared as they would leave the Recorder (masked, and
// cut to one Intelligence event): for every conversation but the one that hands the agent secrets and the one whose
// answer is over 16 KiB, that changes nothing.
import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import { finishAgentEvent } from "../src/background/agent/mask";
import {
  agentEventsFor,
  feed,
  firstThreadOf,
  fixtureNames,
  loadFixture,
  observable,
  observationsOf,
  record,
  sinkEvents,
  withoutDuration,
  withoutSeq,
} from "./agent-traffic";

/** Conversations whose CopilotKit events the Recorder's masking or trimming changes (agent-events-masking.test.ts). */
const CHANGED_ON_THE_WAY_OUT = new Set(["secrets", "long-message"]);

/** CopilotKit's event as it would leave the Recorder: without the sequence number CopilotKit's collector adds. */
const leaving = (event: CapturedEvent): CapturedEvent => {
  const { name, value } = withoutSeq(event);
  return finishAgentEvent(name, value, event.timestamp, new Set());
};

for (const transport of ["sse", "intelligence"] as const)
  describe(`CopilotKit's agent events over ${transport}`, () => {
    for (const name of fixtureNames(transport))
      test(name, async () => {
        const fixture = loadFixture(transport, name);
        const { emitted } = await record(
          observationsOf(fixture, { until: fixture.replayFromAt }),
        );
        const copilotKit = sinkEvents(fixture.sink)
          .filter(observable)
          .map(withoutSeq);
        const expected = sinkEvents(fixture.sink)
          .filter(observable)
          .map(leaving)
          .map(withoutSeq);
        expect(expected.length).toBeGreaterThan(0);
        if (!CHANGED_ON_THE_WAY_OUT.has(name))
          expect(expected).toEqual(copilotKit);
        expect(
          emitted.filter(observable).map(withoutSeq).map(withoutDuration),
        ).toEqual(expected.map(withoutDuration));
      });

    test("a frontend tool executes from its run's RUN_FINISHED until the request that carries its result, and lasts the gap between them", async () => {
      const fixture = loadFixture(transport, "frontend-tool");
      const observations = observationsOf(fixture);
      const { emitted } = await record(observations);
      const phase = (event: CapturedEvent, value: string) =>
        event.name === "tool.call" &&
        (event.value as { phase?: unknown }).phase === value;
      const executing = emitted.find((event) => phase(event, "executing"));
      const completed = emitted.find((event) => phase(event, "completed"));
      const finished = observations.find(
        (observation) =>
          observation.kind === "event" &&
          (observation.event as { type?: unknown }).type === "RUN_FINISHED",
      );
      const followUp = observations.filter(
        (observation) => observation.kind === "request",
      )[1];
      expect(executing?.timestamp).toBe(finished?.at as number);
      expect(completed?.timestamp).toBe(followUp?.at as number);
      const { durationMs } = (completed as CapturedEvent).value as {
        durationMs: number;
      };
      expect(durationMs).toBe(
        (followUp?.at as number) - (finished?.at as number),
      );
      // CopilotKit timed the tool inside the page, before the request went out: never longer than the gap.
      const theirs = sinkEvents(fixture.sink).find((event) =>
        phase(event, "completed"),
      );
      expect(durationMs).toBeGreaterThanOrEqual(
        ((theirs as CapturedEvent).value as { durationMs: number }).durationMs,
      );
      expect(durationMs).toBeLessThan(10);
    });

    test("thread.linked once for a Thread whatever its runs, as CopilotKit's legacy capture sends it, before the Thread's first event", async () => {
      const fixture = loadFixture(transport, "two-runs");
      const { emitted } = await record(observationsOf(fixture));
      const threadId = firstThreadOf(fixture);
      const linked = emitted.filter((event) => event.name === "thread.linked");
      expect(linked.map((event) => event.value)).toEqual([
        { threadId, agentId: "default", hasMessages: false, reason: "open" },
      ]);
      expect(emitted[0]).toBe(linked[0] as CapturedEvent);
    });

    test("a page that reloads replays the Thread: the runs already recorded are not recorded again, and the replay is counted", async () => {
      const fixture = loadFixture(transport, "reload");
      const observations = observationsOf(fixture);
      const { emitted, agentEvents } = agentEventsFor();
      const from = fixture.replayFromAt as number;
      await feed(
        agentEvents,
        observations.filter(
          (observation) => observation.at < 1_792_000_000_000 + from,
        ),
      );
      agentEvents.tabNavigated(1);
      await feed(
        agentEvents,
        observations.filter(
          (observation) => observation.at >= 1_792_000_000_000 + from,
        ),
      );
      expect(emitted.filter(observable).map(withoutSeq)).toEqual(
        sinkEvents(fixture.sink).filter(observable).map(withoutSeq),
      );
      const replayed = emitted.filter(
        (event) =>
          event.name === "recorder.dropped" &&
          (event.value as { reason: string }).reason === "agent-replayed",
      );
      expect(replayed.length).toBeGreaterThan(0);
    });

    test("a replay of a run the recording never saw is recorded as the reloaded page's CopilotKit records it", async () => {
      const fixture = loadFixture(transport, "reload");
      const { emitted } = await record(
        observationsOf(fixture, { from: fixture.replayFromAt }),
      );
      expect(emitted.filter(observable).map(withoutSeq)).toEqual(
        sinkEvents(fixture.replaySink ?? [])
          .filter(observable)
          .map(withoutSeq),
      );
    });
  });

test("thread.linked as CopilotKit's legacy capture sent it for two chats on one page: each Thread linked before its first message, with its agent, field for field", async () => {
  const fixture = loadFixture("sse", "clicks");
  const { emitted } = await record(observationsOf(fixture));
  const rows = (events: CapturedEvent[]) =>
    events
      .filter((event) => event.name === "thread.linked" || observable(event))
      .map(withoutSeq);
  const copilotKit = rows(sinkEvents(fixture.sink));
  expect(
    copilotKit.filter(({ name }) => name === "thread.linked"),
  ).toHaveLength(2);
  expect(rows(emitted)).toEqual(copilotKit);
});
