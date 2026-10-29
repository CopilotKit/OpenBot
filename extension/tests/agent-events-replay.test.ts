// Real recordings cut where a person's browser cuts them: a recording that began during a run, and a page that reloads
// in the middle of a run and replays its Thread. The agent events wait for a run's start, never invent its end, and
// record each run and each event once.
import { describe, expect, test } from "bun:test";
import type { CapturedEvent } from "@openbot/shared/recorder-masking";
import type { AgentObservation } from "../src/background/agent/observation";
import {
  agentEventsFor,
  CLOCK,
  feed,
  loadFixture,
  observable,
  observationsOf,
  sinkEvents,
  withoutSeq,
} from "./agent-traffic";

const typeOf = (observation: AgentObservation) =>
  observation.kind === "event"
    ? (observation.event as { type?: string }).type
    : undefined;

const dropped = (emitted: CapturedEvent[], reason: string) =>
  emitted
    .filter(
      (event) =>
        event.name === "recorder.dropped" &&
        (event.value as { reason: string }).reason === reason,
    )
    .reduce((sum, event) => sum + (event.value as { count: number }).count, 0);

const runsOf = (events: CapturedEvent[]) =>
  events
    .filter((event) => event.name === "agent.run")
    .map(
      (event) => withoutSeq(event).value as { phase: string; runId: string },
    );

for (const transport of ["sse", "intelligence"] as const)
  describe(`over ${transport}`, () => {
    test("a recording that begins during a run waits for the next RUN_STARTED, and counts what it skipped", async () => {
      const fixture = loadFixture(transport, "two-runs");
      const all = observationsOf(fixture);
      const firstStart = all.findIndex(
        (observation) => typeOf(observation) === "RUN_STARTED",
      );
      const joined = all.slice(firstStart + 1);
      const { emitted, agentEvents } = agentEventsFor();
      await feed(agentEvents, joined);
      agentEvents.tabNavigated(1);

      const copilotKit = sinkEvents(fixture.sink).filter(observable);
      const [first, second] = runsOf(copilotKit)
        .filter((run) => run.phase === "started")
        .map((run) => run.runId);
      const recorded = emitted.filter(observable);
      expect(runsOf(recorded).map((run) => run.runId)).not.toContain(first);
      expect(runsOf(recorded)).toEqual(
        runsOf(copilotKit).filter((run) => run.runId === second),
      );
      // The second run's answer is CopilotKit's, field for field.
      const answer = (events: CapturedEvent[]) =>
        events
          .filter(
            (event) =>
              event.name === "agent.message" &&
              (event.value as { role: string }).role === "assistant",
          )
          .map(withoutSeq)
          .at(-1);
      expect(answer(recorded)).toEqual(answer(copilotKit));
      const skipped = joined.filter(
        (observation) =>
          observation.kind === "event" &&
          observation.at <
            (all.find(
              (later, index) =>
                index > firstStart && typeOf(later) === "RUN_STARTED",
            )?.at ?? Number.POSITIVE_INFINITY),
      ).length;
      expect(skipped).toBeGreaterThan(0);
      expect(dropped(emitted, "agent-mid-run")).toBe(skipped);
    });
  });

/** The recording until a page reloads after `contents` streamed text deltas of its first run: that stream fails there. */
function cutShort(observations: AgentObservation[], contents: number) {
  let seen = 0;
  let cutAt: number | null = null;
  let stream: string | null = null;
  const kept: AgentObservation[] = [];
  for (const observation of observations) {
    if (cutAt !== null && observation.streamId === stream) continue;
    kept.push(observation);
    if (typeOf(observation) === "TEXT_MESSAGE_CONTENT" && ++seen === contents) {
      cutAt = observation.at;
      stream = observation.streamId;
      kept.push({
        kind: "end",
        tabId: observation.tabId,
        streamId: observation.streamId,
        at: observation.at,
        outcome: "failed",
      });
    }
  }
  return kept;
}

test("a run cut short by a reload carries on from the Intelligence replay, which names each event: every event is recorded once and the answer is whole", async () => {
  const fixture = loadFixture("intelligence", "reload");
  const from = CLOCK + (fixture.replayFromAt as number);
  const observations = observationsOf(fixture);
  const before = cutShort(
    observations.filter((observation) => observation.at < from),
    3,
  );
  const { emitted, agentEvents } = agentEventsFor();
  await feed(agentEvents, before);
  // Cut short, the run is neither finished nor its answer announced: nothing is invented for it.
  expect(runsOf(emitted).map((run) => run.phase)).toEqual(["started"]);
  agentEvents.tabNavigated(1);
  await feed(
    agentEvents,
    observations.filter((observation) => observation.at >= from),
  );
  expect(emitted.filter(observable).map(withoutSeq)).toEqual(
    sinkEvents(fixture.sink).filter(observable).map(withoutSeq),
  );
  expect(dropped(emitted, "agent-replayed")).toBeGreaterThan(0);
});

test("a run cut short over SSE stays open and is never finished for it, and the replay, which names no event, is not recorded again", async () => {
  const fixture = loadFixture("sse", "reload");
  const from = CLOCK + (fixture.replayFromAt as number);
  const observations = observationsOf(fixture);
  const { emitted, agentEvents } = agentEventsFor();
  await feed(
    agentEvents,
    cutShort(
      observations.filter((observation) => observation.at < from),
      2,
    ),
  );
  agentEvents.tabNavigated(1);
  await feed(
    agentEvents,
    observations.filter((observation) => observation.at >= from),
  );
  const copilotKit = sinkEvents(fixture.sink)
    .filter(observable)
    .map(withoutSeq);
  // The person's message and the run's start, as CopilotKit emitted them, and nothing the cut stream never said.
  expect(emitted.filter(observable).map(withoutSeq)).toEqual(
    copilotKit.slice(0, 2),
  );
  expect(dropped(emitted, "agent-replayed")).toBeGreaterThan(0);
});
