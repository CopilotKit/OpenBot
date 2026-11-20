// A recording that stops in the middle of a run, on a real recording with state: a state change held to be merged with
// the next goes out when the recording stops, and nothing the library is still applying afterwards is emitted.
import { expect, test } from "bun:test";
import type { AgentObservation } from "../src/background/agent/observation";
import {
  agentEventsFor,
  feed,
  loadFixture,
  observationsOf,
  settle,
} from "./agent-traffic";

const typeOf = (observation: AgentObservation) =>
  observation.kind === "event"
    ? (observation.event as { type?: string }).type
    : undefined;

test("a state change held at stop goes out, and what is fed as the recording stops is not emitted after it", async () => {
  const observations = observationsOf(loadFixture("sse", "state"));
  const delta = observations.findIndex(
    (observation) => typeOf(observation) === "STATE_DELTA",
  );
  const { emitted, agentEvents } = agentEventsFor();
  await feed(agentEvents, observations.slice(0, delta + 1));
  const deltas = () =>
    emitted.filter(
      (event) =>
        (event.value as { event?: { type?: string } }).event?.type ===
        "STATE_DELTA",
    );
  // Held, to be merged with a next delta that may follow.
  expect(deltas()).toHaveLength(0);

  const next = observations[delta + 1] as AgentObservation;
  agentEvents.observe(next);
  agentEvents.stop();
  expect(deltas()).toHaveLength(1);
  const count = emitted.length;
  await settle();
  expect(emitted).toHaveLength(count);
});
