// The heart of the agent events: for real traffic from a real CopilotKit runtime and real OpenAI agents, recorded with
// what CopilotKit itself emitted for it (scripts/agent-traffic/record.ts), the Recorder emits CopilotKit's own
// `agent.run`, `agent.message` and `tool.call` events, field for field and in the same order, over SSE and over the
// Intelligence WebSocket alike. Only what CopilotKit sees inside the page and the network does not (a frontend tool
// running: `tool.call` executing and completed) is left out of the comparison. CopilotKit's events are compared as they
// would leave the Recorder (masked, and cut to one Intelligence event): for every conversation but the one that hands
// the agent secrets and the one whose answer is over 16 KiB, that changes nothing.
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
        expect(emitted.filter(observable).map(withoutSeq)).toEqual(expected);
      });

    test("one thread.linked per Thread, as CopilotKit's authenticated capture sends it, at the Thread's first run", async () => {
      const fixture = loadFixture(transport, "two-runs");
      const { emitted } = await record(observationsOf(fixture));
      const threadId = firstThreadOf(fixture);
      const linked = emitted.filter((event) => event.name === "thread.linked");
      expect(linked.map((event) => event.value)).toEqual([{ threadId }]);
      const firstRun = emitted.findIndex((event) => event.name === "agent.run");
      expect(emitted.indexOf(linked[0] as never)).toBe(firstRun - 1);
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
